use sha2::{Digest, Sha256};

/// Same key the Node read-model cache writes. `live_offers` is never cached.
#[allow(clippy::too_many_arguments)]
pub fn card_page_key(
    game: &str,
    card_id: &str,
    lang: &str,
    include_offers: bool,
    include_sales: bool,
    include_same_as: bool,
    live_offers: bool,
) -> String {
    if live_offers || card_id.trim().is_empty() {
        return String::new();
    }
    let lang = if lang.is_empty() {
        "en".to_string()
    } else {
        lang.to_ascii_lowercase()
    };
    format!(
        "card-page:v1:{}:{}:{}:{}:{}:{}",
        if game.is_empty() { "pokemon" } else { game },
        card_id.trim(),
        lang,
        if include_offers { "offers" } else { "nooffers" },
        if include_sales { "sales" } else { "nosales" },
        if include_same_as { "same" } else { "nosame" },
    )
}

pub fn card_generation_key(game: &str, card_id: &str) -> String {
    format!(
        "gen:v1:card:{}:{card_id}",
        if game.is_empty() { "pokemon" } else { game }
    )
}

/// Bounded like the Node cache: query length 2–48, offset 0, limit 1–48.
#[allow(clippy::too_many_arguments)]
pub fn search_page_key(
    game: &str,
    query: &str,
    lang: &str,
    limit: i64,
    offset: i64,
    product_type: &str,
    print_language: &str,
    product_search_only: bool,
) -> String {
    let text = query.trim().to_ascii_lowercase();
    if text.len() < 2 || text.len() > 48 || offset != 0 || !(1..=48).contains(&limit) {
        return String::new();
    }
    let digest = Sha256::digest(text.as_bytes());
    let prefix = hex::encode(&digest[..8]);
    let lang = if lang.is_empty() {
        "en".to_string()
    } else {
        lang.to_ascii_lowercase()
    };
    format!(
        "search-page:v1:{}:{}:{}:{}:{}:{}:{}",
        if game.is_empty() { "pokemon" } else { game },
        lang,
        product_type,
        if print_language.is_empty() {
            "all"
        } else {
            print_language
        },
        if product_search_only {
            "products"
        } else {
            "mixed"
        },
        limit,
        prefix,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_key_matches_the_node_shape() {
        assert_eq!(
            card_page_key("pokemon", "693360", "en", false, false, false, false),
            "card-page:v1:pokemon:693360:en:nooffers:nosales:nosame"
        );
        assert_eq!(
            card_page_key("pokemon", "693360", "en", false, false, false, true),
            ""
        );
    }

    #[test]
    fn search_key_rejects_unbounded_queries() {
        assert_eq!(
            search_page_key("pokemon", "a", "en", 24, 0, "", "all", false),
            ""
        );
        assert!(
            search_page_key("pokemon", "charizard", "en", 24, 0, "", "all", false)
                .starts_with("search-page:v1:pokemon:en::all:mixed:24:")
        );
    }
}
