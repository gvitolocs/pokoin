//! Port of `_slug.js` plus the identical `slugify` of
//! `marketplace-expansions.js` / `marketplace-expansion-page.js`.

/// `foldDiacritics(value)` — NFKD then strip U+0300..U+036F combining marks.
pub fn fold_diacritics(value: &str) -> String {
    let folded: String = value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect();
    folded
}

/// `slugPart(value)`.
pub fn slug_part(value: &str) -> String {
    let lowered = fold_diacritics(value).trim().to_lowercase();
    let dashed = dash_re().replace_all(&lowered, "-");
    dashed.trim_matches('-').to_string()
}

/// `slugify(value)` of the expansions/expansion-page handlers: like
/// [`slug_part`] but `&` becomes ` and ` first and the result caps at 140
/// UTF-16 units.
pub fn slugify(value: &str) -> String {
    let lowered = fold_diacritics(value).trim().to_lowercase();
    let with_and = lowered.replace('&', " and ");
    let dashed = dash_re().replace_all(&with_and, "-");
    super::js::slice_utf16(dashed.trim_matches('-'), 140)
}

/// `normalizeLegacyPokemonSlugParts(parts)` — `pok`+`mon` folds to `pokemon`.
pub fn normalize_legacy_pokemon_slug_parts(parts: &[&str]) -> Vec<String> {
    let mut normalized = Vec::with_capacity(parts.len());
    let mut index = 0usize;
    while index < parts.len() {
        if parts[index] == "pok" && parts.get(index + 1) == Some(&"mon") {
            normalized.push("pokemon".to_string());
            index += 2;
        } else {
            normalized.push(parts[index].to_string());
            index += 1;
        }
    }
    normalized
}

/// `slugParts(value)`.
pub fn slug_parts(value: &str) -> Vec<String> {
    let slug = slug_part(value);
    if slug.is_empty() {
        return Vec::new();
    }
    let parts: Vec<&str> = slug.split('-').filter(|part| !part.is_empty()).collect();
    normalize_legacy_pokemon_slug_parts(&parts)
}

use unicode_normalization::UnicodeNormalization;

fn dash_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[^a-z0-9]+").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_part_folds_and_dashes() {
        assert_eq!(slug_part(" Pokémon -- Card! "), "pokemon-card");
        assert_eq!(slug_part("Paldea Evolved"), "paldea-evolved");
        assert_eq!(slug_part("Team Up"), "team-up");
        assert_eq!(slug_part(""), "");
        assert_eq!(slug_part("!!!"), "");
    }

    #[test]
    fn slugify_expands_ampersand_and_caps() {
        assert_eq!(slugify("Black & White"), "black-and-white");
        assert_eq!(slugify("Sword & Shield—Promo"), "sword-and-shield-promo");
        assert_eq!(slugify("é"), "e");
        let long = "x".repeat(200);
        assert_eq!(slugify(&long).chars().count(), 140);
    }

    #[test]
    fn legacy_pokemon_parts_fold() {
        assert_eq!(
            slug_parts("Pok mon Base"),
            vec!["pokemon".to_string(), "base".to_string()]
        );
        assert_eq!(slug_parts("sword"), vec!["sword".to_string()]);
        assert!(slug_parts("").is_empty());
        assert_eq!(
            normalize_legacy_pokemon_slug_parts(&["pok", "mon", "x"]),
            vec!["pokemon".to_string(), "x".to_string()]
        );
        assert_eq!(
            normalize_legacy_pokemon_slug_parts(&["pok"]),
            vec!["pok".to_string()]
        );
    }
}
