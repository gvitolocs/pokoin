//! Final-text cleanup, matching Hermes `sanitizePokoOutput` / `sanitizePokoReply`.
//!
//! Tool-call markup, raw tool names, markdown emphasis, and markdown headings
//! never reach the website. A reply that still talks about private operator
//! tools is replaced with the fixed refusal.

use std::sync::OnceLock;

use regex::Regex;

const MARKUP_FALLBACK: &str = "Scusa, non sono riuscito a completare la risposta: riprova tra un attimo ✨ / Sorry, I could not finish that answer, please ask again in a moment ✨";
const PRIVATE_REFUSAL: &str = "I can’t access private operator tools or personal services. I can help with Pokoin support and public Pokoin context.";

fn markup_detector() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)</?\s*[\w-]*function_calls?\b|</?\s*(?:invoke|tool_call|tool_use|function)\b|<parameter\s+name=|<\|(?:tool|function|python|redacted_tool)[\w_]*\|>|\binvoke="[a-z_]+"\s*>|\{\s*"(?:tool|function|name|action)"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|params|parameters|input)"\s*:|DSML|[｜\|]{1,2}DSML[｜\|]{1,2}"#,
        )
        .expect("markup detector")
    })
}

fn dsml_blocks() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?is)<[｜\|]+[^>]*DSML[^>]*>.*?</[｜\|]+[^>]*DSML[^>]*>|<[｜\|]+[^>]*DSML[^>]*>",
        )
        .expect("dsml blocks")
    })
}

fn paired_markup() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?is)<(?:[\w-]*function_calls?|tool_call|tool_use)\b[^>]*>.*?</(?:[\w-]*function_calls?|tool_call|tool_use)\s*>",
        )
        .expect("paired markup")
    })
}

fn special_tokens() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"<\|[^|]*\|>").expect("special tokens"))
}

fn json_tool_blob() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)\{\s*"(?:tool|function|name|action)"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|params|parameters|input)"\s*:\s*\{[^{}]*\}\s*\}?"#,
        )
        .expect("json tool blob")
    })
}

fn leftover_tags() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)</?[\w-]+(?:\s[^>]*)?>|\binvoke="[a-z_]+"\s*>"#).expect("leftover tags")
    })
}

fn paren_tool_list() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)\s*\((?:\s*(?:card_quote|card_ocr|card_liquidity|card_sales|deal_check|set_sales|recent_sales|top_sellers|top_movers|artist_cards|set_info|market_query|market_snapshot|suggest_cards|resolve_card|collection_quote|ecc\.?|etc\.?|e|and|,)\s*)+\)",
        )
        .expect("paren tool list")
    })
}

fn tool_names() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"\b(?:card_quote|card_ocr|card_liquidity|card_sales|deal_check|set_sales|recent_sales|top_sellers|top_movers|artist_cards|set_info|market_query|market_snapshot|suggest_cards|resolve_card|collection_quote)\b",
        )
        .expect("tool names")
    })
}

fn markdown_link() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\[([^\]]*)\]\((https?://[^)\s]+)\)").expect("markdown link")
    })
}

fn bold() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*").expect("bold"))
}

fn italic() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\*([^*\n]+)\*").expect("italic"))
}

fn code() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"`([^`]+)`").expect("code"))
}

fn leading_rate() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)^\s*\(?\s*1\s*PKN\s*=\s*€?\s*0[.,]005\s*\)?\s*[:.\-–—]?\s*")
            .expect("leading rate")
    })
}

fn paren_rate() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\(\s*1\s*PKN\s*=\s*€?\s*0[.,]005\s*\)").expect("paren rate")
    })
}

fn headings() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?m)^#{1,6}[ \t]+").expect("headings"))
}

fn spaces() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"[ \t]{2,}").expect("spaces"))
}

/// True when the model leaked provider tool-call syntax into assistant text.
pub(crate) fn contains_tool_markup(text: &str) -> bool {
    markup_detector().is_match(text)
}

fn strip_dsml_lines(text: &str) -> String {
    text.lines()
        .filter(|line| !(line.contains("DSML") && (line.contains('｜') || line.contains("<｜"))))
        .collect::<Vec<_>>()
        .join("\n")
}

fn strip_markup(text: &str) -> String {
    let mut step = dsml_blocks().replace_all(text, " ").to_string();
    while dsml_blocks().is_match(&step) {
        step = dsml_blocks().replace_all(&step, " ").to_string();
    }
    step = strip_dsml_lines(&step);
    let step = paired_markup().replace_all(&step, " ");
    let step = special_tokens().replace_all(&step, " ");
    let step = json_tool_blob().replace_all(&step, " ");
    let step = leftover_tags().replace_all(&step, " ");
    spaces().replace_all(step.trim(), " ").trim().to_string()
}

fn pokemon_or_card() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:pokemon|pokémon|poké|tcg|holo|rayquaza|charizard|pikachu|eevee|jolteon|vaporeon|flareon|umbreon|espeon|sylveon|mewtwo|mew|card|cards|illustration|full\s+art)\b")
            .expect("pokemon chat")
    })
}

fn hard_private() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(?:gmail|inbox|google\s+sheets?|google\s+drive|journalctl|ripgrep|comfyui|private\s+memory|private\s+chats?|operator\s+tasks?)\b")
            .expect("hard private")
    })
}

fn private_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)\bgmail\b",
            r"(?i)\bgoogle\s+mail\b",
            r"(?i)\binbox\b",
            r"(?i)\bemail\b",
            r"(?i)\bmail\b",
            r"(?i)\bsheet\s+updates?\b",
            r"(?i)\bspreadsheet\s+updates?\b",
            r"(?i)\bgoogle\s+sheets?\b",
            r"(?i)\bgoogle\s+drive\b",
            r"(?i)\bdrive\s+(?:sheet|spreadsheet|workbook|file|document)s?\b",
            r"(?i)\bcursor\b",
            r"(?i)\bcode\s+tasks?\b",
            r"(?i)\bproject\s+work\b",
            r"(?i)\boperator\s+tasks?\b",
            r"(?i)\bprivate\s+automation\b",
            r"(?i)\bprivate\s+memory\b",
            r"(?i)\bprivate\s+chats?\b",
            r"(?i)\btelegram\s+chats?\b",
            r"(?i)\bhidden\s+(?:system|runtime)\s+context\b",
            r"(?i)\bserver\s+diagnostics?\b",
            r"(?i)\boracle\s+(?:monitor|diagnostics?|instances?|servers?)\b",
            r"(?i)\bjournalctl\b",
            r"(?i)\bripgrep\b",
            r"(?i)\bgemini\s+cli\b",
            r"(?i)\bcomfyui\b",
            r"(?i)\bpersonal\s+reminders?\b",
            r"(?i)\b(?:ask|tell|ping|use|call)\s+flareon\b",
            r"(?i)\bflareon(?:'s)?\s+(?:tools?|gmail|mail|inbox|sheets?|cursor|operator|memory|chats?|assistant)\b",
            r"(?i)\b(?:ask|tell|ping|use|call)\s+hermes\b",
            r"(?i)\bhermes\s+(?:tools?|operator|runtime|memory|bot|assistant)\b",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("private pattern"))
        .collect()
    })
}

fn leaky_menu() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)\bwhat\s+are\s+we\s+running\s+today\b",
            r"(?i)\bwhat\s+are\s+we\s+running\b",
            r"(?i)\brunning\s+today\b",
            r"(?i)\b(?:news|sheet|gmail|mail|cursor|project|operator).{0,80}\b(?:news|sheet|gmail|mail|cursor|project|operator)\b",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("leaky menu"))
        .collect()
    })
}

fn contains_private_leak(text: &str) -> bool {
    if text.trim().is_empty() {
        return false;
    }
    if pokemon_or_card().is_match(text) && !hard_private().is_match(text) {
        return leaky_menu().iter().any(|pattern| pattern.is_match(text));
    }
    private_patterns()
        .iter()
        .any(|pattern| pattern.is_match(text))
        || leaky_menu().iter().any(|pattern| pattern.is_match(text))
}

fn sanitize_emoji(value: &str) -> String {
    const REPLACEMENTS: &[(&str, &str)] = &[
        ("🃏", "⭐"),
        ("🫧", "✨"),
        ("🫠", "😊"),
        ("⛓️", "🛠️"),
        ("⛓", "🛠️"),
        ("🦊", "🛠️"),
        ("📒", "📚"),
        ("✅", "⭐"),
        ("🐣", "😊"),
        ("🔑", "🛠️"),
        ("💪", "⭐"),
        ("💕", "💛"),
        ("😌", "😊"),
        ("📨", "🛠️"),
        ("💌", "💛"),
        ("🧭", "📚"),
        ("⚠️", "🛠️"),
        ("⚠", "🛠️"),
        ("🟢", "⭐"),
        ("🟡", "⭐"),
        ("⚡", "⭐"),
        ("💗", "💛"),
    ];
    let mut sanitized = value.to_string();
    for (emoji, replacement) in REPLACEMENTS {
        sanitized = sanitized.replace(emoji, replacement);
    }
    // Drop replacement characters, ZWJ, and astral emoji outside the safe set.
    const SAFE_ASTRAL: [char; 4] = ['😊', '📚', '🛠', '💛'];
    sanitized
        .chars()
        .filter(|ch| {
            (*ch != '\u{FFFD}' && *ch != '\u{200D}' && (*ch as u32) < 0x1_0000)
                || SAFE_ASTRAL.contains(ch)
        })
        .collect()
}

pub(crate) fn sanitize_poko_output(value: &str) -> String {
    let without_markup = strip_markup(value);
    if contains_tool_markup(value)
        && without_markup
            .chars()
            .filter(|ch| !ch.is_ascii_digit() && !ch.is_whitespace())
            .count()
            < 20
    {
        return MARKUP_FALLBACK.to_string();
    }
    let plain = paren_tool_list().replace_all(&without_markup, "");
    let plain = tool_names().replace_all(&plain, "Pokoin market data");
    let plain = markdown_link().replace_all(&plain, |caps: &regex::Captures| {
        let label = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        let url = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if label.is_empty() || label == url {
            url.to_string()
        } else {
            format!("{label}: {url}")
        }
    });
    let plain = bold().replace_all(&plain, "$1");
    let plain = italic().replace_all(&plain, "$1");
    let plain = code().replace_all(&plain, "$1");
    let plain = leading_rate().replace_all(&plain, "");
    let plain = paren_rate().replace_all(&plain, "");
    let plain = headings().replace_all(&plain, "");
    let plain = spaces().replace_all(plain.trim(), " ");
    let plain = sanitize_emoji(plain.trim());
    let text = plain.trim().to_string();
    if text.is_empty() {
        return String::new();
    }
    if contains_private_leak(&text) {
        PRIVATE_REFUSAL.to_string()
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markdown_tool_names_and_headings() {
        let cleaned = sanitize_poko_output(
            "# Price\n**Lugia** is `1200` PKN from card_quote (card_liquidity, set_info). See [the card](https://pokoin.com/marketplace).",
        );
        assert!(!cleaned.contains('#'));
        assert!(!cleaned.contains("**"));
        assert!(!cleaned.contains('`'));
        assert!(!cleaned.contains("card_quote"));
        assert!(cleaned.contains("Pokoin market data"));
        assert!(cleaned.contains("the card: https://pokoin.com/marketplace"));
        assert!(cleaned.contains("Lugia"));
    }

    #[test]
    fn drops_the_fixed_pkn_rate_line() {
        let cleaned = sanitize_poko_output("(1 PKN = €0.005) Lugia asks are 1200 PKN.");
        assert!(!cleaned.to_ascii_lowercase().contains("0.005"));
        assert!(cleaned.contains("1200 PKN"));
    }

    #[test]
    fn tool_markup_with_no_prose_uses_the_fallback() {
        let cleaned =
            sanitize_poko_output(r#"{"tool":"card_quote","arguments":{"query":"Lugia"}}"#);
        assert!(cleaned.contains("Sorry, I could not finish"));
    }

    #[test]
    fn private_operator_leaks_become_the_refusal() {
        let cleaned = sanitize_poko_output("I can read your gmail inbox.");
        assert!(cleaned.contains("private operator tools"));
    }

    #[test]
    fn a_flareon_card_is_not_an_operator_leak() {
        let cleaned = sanitize_poko_output("Flareon from Jungle is a cute card.");
        assert!(cleaned.contains("Flareon"));
        assert!(!cleaned.contains("private operator"));
    }

    const DSML_SAMPLE: &str = "\
<｜｜DSML｜｜ calls>\n\
<｜｜DSML｜｜ invoke name=\"Pokoin market data\">\n\
<｜｜DSML｜｜ parameter name=\"cardId\" string=\"true\">332906</｜｜DSML｜｜ parameter>\n\
<｜｜DSML｜｜ parameter name=\"days\" string=\"false\">90</｜｜DSML｜｜ parameter>\n\
</｜｜DSML｜｜ invoke>\n\
</｜｜DSML｜｜ calls>";

    #[test]
    fn dsml_sample_is_detected_and_stripped() {
        assert!(contains_tool_markup(DSML_SAMPLE));
        let cleaned = sanitize_poko_output(DSML_SAMPLE);
        assert!(!contains_tool_markup(&cleaned));
        assert!(cleaned.contains("Sorry, I could not finish"));
    }

    #[test]
    fn dsml_one_bar_variant_is_detected() {
        let sample = "<｜DSML｜invoke name=\"card_quote\"></｜DSML｜invoke>";
        assert!(contains_tool_markup(sample));
        let cleaned = sanitize_poko_output(sample);
        assert!(!contains_tool_markup(&cleaned));
    }

    #[test]
    fn mixed_prose_and_dsml_keeps_prose() {
        let mixed = format!("Lugia sold well last month.\n\n{DSML_SAMPLE}");
        assert!(contains_tool_markup(&mixed));
        let cleaned = sanitize_poko_output(&mixed);
        assert!(!contains_tool_markup(&cleaned));
        assert!(cleaned.contains("Lugia sold well"));
        assert!(!cleaned.contains("DSML"));
        assert!(!cleaned.contains("332906"));
    }

    #[test]
    fn plain_text_has_no_tool_markup() {
        assert!(!contains_tool_markup("Pikachu is 58/102 from Base Set."));
        let cleaned = sanitize_poko_output("Pikachu is 58/102 from Base Set.");
        assert_eq!(cleaned, "Pikachu is 58/102 from Base Set.");
    }

    #[test]
    fn contains_tool_markup_json_and_angle_tokens() {
        assert!(contains_tool_markup(
            r#"{"name":"card_quote","arguments":{"q":"x"}}"#
        ));
        assert!(contains_tool_markup("<tool_call>card_quote</tool_call>"));
        assert!(!contains_tool_markup("ask price for Charizard"));
    }
}
