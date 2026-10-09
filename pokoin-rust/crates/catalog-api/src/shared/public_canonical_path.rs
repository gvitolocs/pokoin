//! Port of `_public_canonical_path.js`.

/// `publicCanonicalPath(path, slug)` — prefix a router path with the game
/// slug unless it is already prefixed. Pokémon stays unprefixed (empty
/// slug), and so do already-prefixed paths.
pub fn public_canonical_path(path: &str, slug: &str) -> String {
    let raw = path.trim();
    let prefix = slug.trim_matches('/');
    if raw.is_empty() || prefix.is_empty() {
        return raw.to_string();
    }
    if raw == format!("/{prefix}") || raw.starts_with(&format!("/{prefix}/")) {
        return raw.to_string();
    }
    if raw.starts_with('/') {
        format!("/{prefix}{raw}")
    } else {
        format!("/{prefix}/{raw}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_only_unprefixed_paths() {
        assert_eq!(
            public_canonical_path("/marketplace/en/cards/1/x", "one-piece"),
            "/one-piece/marketplace/en/cards/1/x"
        );
        assert_eq!(
            public_canonical_path("/one-piece/marketplace/x", "one-piece"),
            "/one-piece/marketplace/x"
        );
        assert_eq!(
            public_canonical_path("/one-piece", "one-piece"),
            "/one-piece"
        );
        assert_eq!(
            public_canonical_path("/marketplace/x", ""),
            "/marketplace/x"
        );
        assert_eq!(public_canonical_path("", "magic"), "");
        assert_eq!(
            public_canonical_path("relative", "magic"),
            "/magic/relative"
        );
        assert_eq!(public_canonical_path("/x", "/magic/"), "/magic/x");
    }
}
