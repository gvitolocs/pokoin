//! Port of `_artist_display.js` — artist display names, lookup aliases and
//! slug aliases (the 2017 Pikachu Project family).

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

use super::js;

pub const MAX_TEXT: usize = 160;

/// `cleanText(value, maxLength = 160)` of this module.
pub fn clean_text(value: Option<&Value>, max_length: usize) -> String {
    js::clean_text(value, max_length)
}

/// `normalizeArtistLookupName(value)`.
pub fn normalize_artist_lookup_name(value: Option<&Value>) -> String {
    let text = js::clean_text(value, 180).to_lowercase();
    let spaced = non_alnum_to_space().replace_all(&text, " ");
    // `.trim().replace(/\s+/g, ' ')`.
    spaced
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `normalizeArtistSlug(value)`.
pub fn normalize_artist_slug(value: Option<&Value>) -> String {
    let text = js::clean_text(value, 180).to_lowercase();
    let dashed = non_alnum_to_dash().replace_all(&text, "-");
    dashed.trim_matches('-').to_string()
}

fn display_name_overrides() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        HashMap::from([
            ("2017 pikachu project", "Pikachu Project"),
            ("pikachu project 2017", "Pikachu Project"),
        ])
    })
}

fn slug_aliases() -> &'static HashMap<&'static str, &'static [&'static str]> {
    static MAP: OnceLock<HashMap<&'static str, &'static [&'static str]>> = OnceLock::new();
    MAP.get_or_init(|| {
        HashMap::from([
            (
                "2017-pikachu-project",
                &["2017-pikachu-project", "pikachu-project-2017"][..],
            ),
            (
                "pikachu-project",
                &[
                    "pikachu-project",
                    "2017-pikachu-project",
                    "pikachu-project-2017",
                ][..],
            ),
            (
                "pikachu-project-2017",
                &["pikachu-project-2017", "2017-pikachu-project"][..],
            ),
        ])
    })
}

fn lookup_name_aliases() -> &'static HashMap<&'static str, &'static [&'static str]> {
    static MAP: OnceLock<HashMap<&'static str, &'static [&'static str]>> = OnceLock::new();
    MAP.get_or_init(|| {
        HashMap::from([
            (
                "2017 pikachu project",
                &["2017 pikachu project", "pikachu project 2017"][..],
            ),
            (
                "pikachu project",
                &[
                    "pikachu project",
                    "2017 pikachu project",
                    "pikachu project 2017",
                ][..],
            ),
            (
                "pikachu project 2017",
                &["pikachu project 2017", "2017 pikachu project"][..],
            ),
        ])
    })
}

/// `uniqueValues(values)` — cleanText(160) + de-dup, order preserved.
pub fn unique_values<'a>(values: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let clean = js::clean_text_str(value, MAX_TEXT);
        if clean.is_empty() || !seen.insert(clean.clone()) {
            continue;
        }
        result.push(clean);
    }
    result
}

/// `titleFromNormalizedArtist(value)`.
pub fn title_from_normalized_artist(value: Option<&Value>) -> String {
    normalize_artist_lookup_name(value)
        .split(' ')
        .filter(|part| !part.is_empty())
        .map(|part| {
            if part.chars().count() <= 1 {
                part.to_uppercase()
            } else {
                let mut chars = part.chars();
                let first = chars.next().unwrap_or_default();
                format!("{}{}", first.to_uppercase(), chars.as_str())
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `displayNameForArtist({ normalizedArtist, profileDisplayName, fallbackName })`.
pub fn display_name_for_artist(
    normalized_artist: Option<&Value>,
    profile_display_name: Option<&Value>,
    fallback_name: Option<&Value>,
) -> String {
    let normalized = normalize_artist_lookup_name(normalized_artist);
    if let Some(override_name) = display_name_overrides().get(normalized.as_str()) {
        return override_name.to_string();
    }
    let clean_profile_name = js::clean_text(profile_display_name, MAX_TEXT);
    if !clean_profile_name.is_empty() {
        return clean_profile_name;
    }
    let fallback = js::clean_text(fallback_name, MAX_TEXT);
    if !fallback.is_empty() {
        return fallback;
    }
    title_from_normalized_artist(normalized_artist)
}

/// `slugAliasesForArtistSlug(value)`.
pub fn slug_aliases_for_artist_slug(value: Option<&Value>) -> Vec<String> {
    let slug = normalize_artist_slug(value);
    if slug.is_empty() {
        return Vec::new();
    }
    let mut all = vec![slug.clone()];
    if let Some(extra) = slug_aliases().get(slug.as_str()) {
        all.extend(extra.iter().map(|s| s.to_string()));
    }
    unique_values(all.iter().map(String::as_str))
}

/// `lookupAliasesForArtistName(value)`.
pub fn lookup_aliases_for_artist_name(value: Option<&Value>) -> Vec<String> {
    let name = normalize_artist_lookup_name(value);
    if name.is_empty() {
        return Vec::new();
    }
    let mut all = vec![name.clone()];
    if let Some(extra) = lookup_name_aliases().get(name.as_str()) {
        all.extend(extra.iter().map(|s| s.to_string()));
    }
    unique_values(all.iter().map(String::as_str))
}

/// `applyArtistDisplayNameToRow(row)` — denormalize the display name onto the
/// row (`artist`, `illustrator`, `artist_display_name`).
pub fn apply_artist_display_name_to_row(row: &Value) -> Value {
    let display_name = display_name_for_artist(
        js::get(row, "normalized_artist"),
        js::get(row, "profile_display_name"),
        js::get(row, "artist").or_else(|| js::get(row, "illustrator")),
    );
    let normalized_artist = normalize_artist_lookup_name(js::get(row, "normalized_artist"));
    let illustrator = js::get(row, "illustrator");
    let illustrator_matches_artist =
        illustrator.is_none() || normalize_artist_lookup_name(illustrator) == normalized_artist;

    let artist_value = if !display_name.is_empty() {
        Value::String(display_name.clone())
    } else {
        js::or(
            js::get(row, "artist"),
            js::get(row, "illustrator").unwrap_or(&Value::Null),
        )
        .clone()
    };
    let illustrator_value = if illustrator_matches_artist {
        if !display_name.is_empty() {
            Value::String(display_name.clone())
        } else {
            js::or(
                js::get(row, "illustrator"),
                js::get(row, "artist").unwrap_or(&Value::Null),
            )
            .clone()
        }
    } else {
        illustrator.cloned().unwrap_or(Value::Null)
    };

    let mut map = row.as_object().cloned().unwrap_or_default();
    js::set(&mut map, "artist", artist_value);
    js::set(&mut map, "illustrator", illustrator_value);
    js::set(&mut map, "artist_display_name", Value::String(display_name));
    Value::Object(map)
}

fn non_alnum_to_space() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[^a-z0-9]+").expect("valid regex"))
}

fn non_alnum_to_dash() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"[^a-z0-9]+").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lookup_names_normalize() {
        assert_eq!(
            normalize_artist_lookup_name(Some(&json!("  Atsuko!! Nishida "))),
            "atsuko nishida"
        );
        assert_eq!(
            normalize_artist_slug(Some(&json!("  Atsuko!! Nishida "))),
            "atsuko-nishida"
        );
        assert_eq!(normalize_artist_lookup_name(Some(&json!(""))), "");
    }

    #[test]
    fn title_cases_the_normalized_name() {
        assert_eq!(
            title_from_normalized_artist(Some(&json!("atsuko nishida"))),
            "Atsuko Nishida"
        );
        assert_eq!(
            title_from_normalized_artist(Some(&json!("5ban graphics"))),
            "5ban Graphics"
        );
        assert_eq!(title_from_normalized_artist(Some(&json!("a b"))), "A B");
    }

    #[test]
    fn pikachu_project_aliases_resolve() {
        assert_eq!(
            display_name_for_artist(Some(&json!("pikachu project 2017")), None, None),
            "Pikachu Project"
        );
        assert_eq!(
            slug_aliases_for_artist_slug(Some(&json!("pikachu-project"))),
            vec![
                "pikachu-project",
                "2017-pikachu-project",
                "pikachu-project-2017"
            ]
        );
        assert_eq!(
            lookup_aliases_for_artist_name(Some(&json!("Pikachu Project"))),
            vec![
                "pikachu project",
                "2017 pikachu project",
                "pikachu project 2017"
            ]
        );
        assert!(slug_aliases_for_artist_slug(Some(&json!(""))).is_empty());
    }

    #[test]
    fn profile_name_wins_over_fallback() {
        assert_eq!(
            display_name_for_artist(
                Some(&json!("kimura")),
                Some(&json!("K. Kimura")),
                Some(&json!("ken"))
            ),
            "K. Kimura"
        );
        assert_eq!(
            display_name_for_artist(Some(&json!("kimura")), None, Some(&json!("Ken Kimura"))),
            "Ken Kimura"
        );
        assert_eq!(
            display_name_for_artist(Some(&json!("kimura")), None, None),
            "Kimura"
        );
    }

    #[test]
    fn row_application_keeps_mismatched_illustrators() {
        // The fallback name is returned raw (cleanText only trims).
        let row = json!({"normalized_artist": "atsuko nishida", "artist": "atsuko nishida", "illustrator": "Someone Else"});
        let applied = apply_artist_display_name_to_row(&row);
        assert_eq!(applied["artist"], json!("atsuko nishida"));
        assert_eq!(applied["illustrator"], json!("Someone Else"));
        assert_eq!(applied["artist_display_name"], json!("atsuko nishida"));

        let row = json!({"normalized_artist": "atsuko nishida", "illustrator": "Atsuko  Nishida"});
        let applied = apply_artist_display_name_to_row(&row);
        assert_eq!(applied["artist"], json!("Atsuko  Nishida"));
        assert_eq!(applied["illustrator"], json!("Atsuko  Nishida"));
    }
}
