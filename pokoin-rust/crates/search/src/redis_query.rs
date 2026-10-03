/// High-recall Redis Search query. Pokoin ranks the hits afterwards.
pub fn redis_search_query(raw: &str, print_language: &str) -> String {
    let tokens = query_tokens(raw);
    if tokens.is_empty() {
        return String::new();
    }
    let text = tokens
        .iter()
        .map(|token| token_clause(token))
        .collect::<Vec<_>>()
        .join(" ");
    match print_clause(print_language) {
        Some(print) => format!("({text}) {print}"),
        None => text,
    }
}

fn query_tokens(raw: &str) -> Vec<String> {
    let folded: String = raw
        .chars()
        .filter(|ch| *ch != '\'' && *ch != '\u{2019}')
        .collect::<String>()
        .to_lowercase();
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in folded.chars() {
        if ch.is_ascii_alphanumeric() {
            current.push(ch);
        } else if !current.is_empty() {
            push_token(&mut tokens, &current);
            current.clear();
        }
    }
    if !current.is_empty() {
        push_token(&mut tokens, &current);
    }
    tokens.truncate(8);
    tokens
}

fn push_token(tokens: &mut Vec<String>, token: &str) {
    if token.len() < 2 && !token.chars().all(|ch| ch.is_ascii_digit()) {
        return;
    }
    if !tokens.iter().any(|existing| existing == token) {
        tokens.push(token.to_string());
    }
}

fn token_clause(token: &str) -> String {
    if token.chars().all(|ch| ch.is_ascii_digit()) {
        return format!(
            "(@card_number:{token} | @name:{token} | @set_name:{token} | @expansion_name:{token})"
        );
    }
    let mut parts = vec![
        format!("@name:{token}*"),
        format!("@name_compact:{token}*"),
        format!("@name_normalized:{token}*"),
        format!("@nicknames:{token}*"),
        format!("@card_number:{token}*"),
        format!("@set_name:{token}*"),
        format!("@expansion_name:{token}*"),
    ];
    if token.len() >= 6 {
        parts.push(format!("@name:%%{token}%%"));
        parts.push(format!("@name_compact:%%{token}%%"));
    } else if token.len() >= 4 {
        parts.push(format!("@name:%{token}%"));
        parts.push(format!("@name_compact:%{token}%"));
    }
    format!("({})", parts.join(" | "))
}

fn print_clause(value: &str) -> Option<String> {
    let want = value.trim().to_ascii_lowercase();
    if want.is_empty() || want == "all" {
        return None;
    }
    if matches!(
        want.as_str(),
        "japanese" | "ja" | "jp" | "ko" | "korean" | "jpko"
    ) {
        return Some(
            "(@effective_print_bucket:{japanese} | @effective_print_bucket:{korean})".into(),
        );
    }
    if want.len() >= 2
        && want.len() <= 24
        && want
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
    {
        return Some(format!("(@effective_print_bucket:{{{want}}})"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_tokens_search_the_set_name() {
        let query = redis_search_query("base set charizard", "all");
        assert!(query.contains("@set_name:base*"));
        assert!(query.contains("@expansion_name:charizard*"));
    }

    #[test]
    fn pika_is_a_prefix_and_umbrean_is_fuzzy() {
        let pika = redis_search_query("pika", "all");
        assert!(pika.contains("@name_compact:pika*"));
        let umbrean = redis_search_query("umbrean", "all");
        assert!(umbrean.contains("@name_compact:%%umbrean%%"));
    }

    #[test]
    fn professors_research_drops_the_apostrophe() {
        let query = redis_search_query("professor's research", "all");
        assert!(query.contains("@name:professors*"));
        assert!(query.contains("@name:research*"));
        assert!(!query.contains('\''));
    }

    #[test]
    fn collector_numbers_are_exact_tokens() {
        let query = redis_search_query("charizard 4/102", "all");
        assert!(query.contains("@card_number:4"));
        assert!(query.contains("@card_number:102"));
        assert!(!query.contains("@card_number:4*"));
    }

    #[test]
    fn star_suffix_searches_the_name() {
        let query = redis_search_query("Umbreon ☆", "western");
        assert!(query.contains("@name:umbreon*"));
        assert!(query.contains("@effective_print_bucket:{western}"));
        assert!(!query.contains('☆'));
    }
}
