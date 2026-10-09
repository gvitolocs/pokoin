//! Pure helpers of `api/cardmarket-redirect.js` that
//! `marketplace-debug-refinement.js` consumes through
//! `cardmarketRedirect.candidateUrls(row, locale)` — the known Cardmarket set
//! codes, expansion slugs, verified blueprint URLs and the collector-number
//! candidate generation. Only what the refinement route calls is ported.

use unicode_normalization::UnicodeNormalization;

/// `KNOWN_CARDMARKET_SET_CODES`.
fn known_cardmarket_set_code(expansion_name: &str) -> Option<&'static str> {
    const KNOWN: [(&str, &str); 28] = [
        ("Call of Legends", "CL"),
        ("Chaos Rising", "CRI"),
        ("Clash at the Summit", "L3"),
        ("Cosmic Eclipse", "CEC"),
        ("Astral Radiance", "ASR"),
        ("Advent of Arceus", "Pt4"),
        ("CSM1d: Storming Emergence GX Starter Deck", "CSM1DC"),
        ("CS1b: Dynamax Clash - Flame", "CS1bC"),
        ("CSM1c: Storming Emergence - Abundant", "CSM1cC"),
        ("CSVH4pC: Reward Pack", "CSVH4Cp"),
        ("Darkness that Consumes Light", ""),
        ("Dragon Majesty", "DRM"),
        ("EX Holon Phantoms", "HP"),
        ("High Class Pack GX Ultra Shiny", "sm8b"),
        ("Magma Deck Kit", "advF"),
        ("MEGA Start Deck 100 Battle Collection", "mC"),
        ("Mega Brave", "m1L"),
        ("Neo Discovery", "NDI"),
        ("Paldean Fates", "PAF"),
        ("Perfect Order", "POR"),
        ("Rocket Gang Strikes Back", "PCG3"),
        ("Skyridge", "SK"),
        ("SM Black Star Promos", "OSSM"),
        ("Start Deck 100", "sI100"),
        ("SWSH Black Star Promos", "SWSH"),
        ("Scarlet & Violet Simplified Chinese Promos", "SV-PCS"),
        ("White Flare - Poké Ball Reverse Holo", "xWHT"),
        ("XY Black Star Promos", "XYPR"),
    ];
    KNOWN
        .iter()
        .find(|(name, _)| *name == expansion_name)
        .map(|(_, code)| *code)
}

/// `KNOWN_CARDMARKET_EXPANSION_SLUGS`.
fn known_cardmarket_expansion_slug(expansion_name: &str) -> Option<&'static str> {
    const KNOWN: [(&str, &str); 22] = [
        ("Advent of Arceus", "Advent-of-Arceus"),
        ("Astral Radiance", "Astral-Radiance"),
        ("SM Black Star Promos", "SM-Black-Star-Promos"),
        ("CS1b: Dynamax Clash - Flame", "Dynamax-Clash-Flame"),
        (
            "CSM1c: Storming Emergence - Abundant",
            "Storming-Emergence-Abundant",
        ),
        (
            "CSM1d: Storming Emergence GX Starter Deck",
            "Storming-Emergence-GX-Starter-Deck",
        ),
        (
            "CSVH4pC: Reward Pack",
            "Happy-Set-Decidueye-Melmetal-Koraidon-Miraidon",
        ),
        (
            "Darkness that Consumes Light",
            "Darkness-that-Consumes-Light",
        ),
        ("Dragon Majesty", "Dragon-Majesty"),
        ("EX Holon Phantoms", "EX-Holon-Phantoms"),
        ("High Class Pack GX Ultra Shiny", "GX-Ultra-Shiny"),
        ("Magma Deck Kit", "Magma-Deck-Kit"),
        (
            "MEGA Start Deck 100 Battle Collection",
            "MEGA-Start-Deck-100-Battle-Collection",
        ),
        ("Mega Brave", "Mega-Brave"),
        ("Paldean Fates", "Paldean-Fates"),
        ("Perfect Order", "Perfect-Order"),
        (
            "S-P: Sword & Shield Promos",
            "Sword-Shield-Simplified-Chinese-Promos",
        ),
        (
            "Scarlet & Violet Simplified Chinese Promos",
            "Scarlet-Violet-Simplified-Chinese-Promos",
        ),
        (
            "White Flare - Poké Ball Reverse Holo",
            "White-Flare-Additionals",
        ),
        ("World Championship Decks 2006", "WCD-2006"),
        ("World Championship Decks 2007", "WCD-2007"),
        ("XY Black Star Promos", "XY-Black-Star-Promos"),
    ];
    KNOWN
        .iter()
        .find(|(name, _)| *name == expansion_name)
        .map(|(_, slug)| *slug)
}

/// `VERIFIED_BLUEPRINT_URLS` (id -> exact Cardmarket product URL).
fn verified_blueprint_url(card_id: &str) -> Option<&'static str> {
    const VERIFIED: [(&str, &str); 28] = [
        ("228478", "https://www.cardmarket.com/en/Pokemon/Products/Singles/SM-Black-Star-Promos/Detective-Pikachu-V2-OSSM194"),
        ("236544", "https://www.cardmarket.com/en/Pokemon/Products/Singles/SWSH-Black-Star-Promos/Rapidash-SWSH270"),
        ("315033", "https://www.cardmarket.com/en/Pokemon/Products/Singles/WCD-2007/Double-Rainbow-Energy-WCD07CG-088"),
        ("123536", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Kabutops-NDI25"),
        ("388130", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Sword-Shield-Simplified-Chinese-Promos/Friends-in-Alola-S-PCS081"),
        ("136333", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Clash-at-the-Summit/Lickitung-L3061"),
        ("369312", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Dynamax-Clash-Flame/Lum-Berry-CS1bC130"),
        ("142010", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Rocket-Gang-Strikes-Back/Dark-Steelix-PCG3072"),
        ("113087", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Cosmic-Eclipse/Throh-CEC118"),
        ("383285", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Storming-Emergence-GX-Starter-Deck/Energy-Retrieval-CSM1DC230"),
        ("110803", "https://www.cardmarket.com/en/Pokemon/Products/Singles/BREAKthrough/Ralts-BKT100"),
        ("137077", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Darkness-that-Consumes-Light/Pikachu"),
        ("138766", "https://www.cardmarket.com/en/Pokemon/Products/Singles/GX-Ultra-Shiny/Reshiram-GX-V2-sm8b211"),
        ("364150", "https://www.cardmarket.com/en/Pokemon/Products/Singles/MEGA-Start-Deck-100-Battle-Collection/Arvens-Mabosstiff-ex-mC484"),
        ("344716", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Mega-Brave/Mega-Venusaur-ex-V2-m1L076"),
        ("378949", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Perfect-Order/Mega-Zygarde-ex-V2-POR104"),
        ("212782", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Astral-Radiance/Sweet-Honey-ASR153"),
        ("378857", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Perfect-Order/Decidueye-ex-V1-POR012"),
        ("314822", "https://www.cardmarket.com/en/Pokemon/Products/Singles/WCD-2006/Girafarig-V1-WCD06LM-016"),
        ("274416", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Paldean-Fates/Mew-ex-V2-PAF232"),
        ("114322", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Dragon-Majesty/Hydreigon-DRM33"),
        ("132124", "https://www.cardmarket.com/en/Pokemon/Products/Singles/XY-Black-Star-Promos/Jirachi-V2-XYPRXY67a"),
        ("343260", "https://www.cardmarket.com/en/Pokemon/Products/Singles/White-Flare-Additionals/Durant-V2-xWHT070"),
        ("315302", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Magma-Deck-Kit/Team-Magmas-Rhyhorn-advF007"),
        ("331658", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Scarlet-Violet-Simplified-Chinese-Promos/Toedscool-SV-PCS005"),
        ("132211", "https://www.cardmarket.com/en/Pokemon/Products/Singles/XY-Black-Star-Promos/Rayquaza-XYPRXY141"),
        ("135242", "https://www.cardmarket.com/en/Pokemon/Products/Singles/Advent-of-Arceus/Pokemon-Rescue-Pt4080"),
        ("116587", "https://www.cardmarket.com/en/Pokemon/Products/Singles/EX-Holon-Phantoms/Mew-ex-HP100"),
    ];
    VERIFIED
        .iter()
        .find(|(id, _)| *id == card_id)
        .map(|(_, url)| *url)
}

/// `KNOWN_NAME_ONLY_TRAINER_EXPANSIONS`.
fn known_name_only_trainer_expansion(expansion_name: &str) -> bool {
    matches!(expansion_name, "Night Unison" | "Rising Fist")
}

fn strip_diacritics(text: &str) -> String {
    text.nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect()
}

/// `slugPart(value)`: Cardmarket slug rules — ampersands become spaces,
/// apostrophes vanish, the rest collapses to hyphens.
pub(crate) fn slug_part(value: &str) -> String {
    let base = strip_diacritics(value);
    // `.replace(/&/g, ' ')` then `.replace(/['’`]/g, '')` then collapse every
    // non-alphanumeric run into one hyphen, in that order.
    let mut stage1 = String::with_capacity(base.len());
    for ch in base.chars() {
        match ch {
            '&' => stage1.push(' '),
            '\'' | '\u{2019}' | '`' => {}
            other => stage1.push(other),
        }
    }
    let mut out = String::with_capacity(stage1.len());
    let mut last_was_separator = false;
    for ch in stage1.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_separator = false;
        } else if !last_was_separator {
            out.push('-');
            last_was_separator = true;
        }
    }
    out.trim_matches('-').to_owned()
}

/// `cardNameSlug(name)`.
pub(crate) fn card_name_slug(name: &str) -> String {
    static SHINY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static HOLO: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static PLAIN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let shiny = SHINY.get_or_init(|| regex::Regex::new(r"(?i)\bShiny Rare\b").unwrap());
    let rare_holo = HOLO.get_or_init(|| regex::Regex::new(r"(?i)\bRare Holo\b").unwrap());
    let holo = PLAIN.get_or_init(|| regex::Regex::new(r"(?i)\bHolo\b").unwrap());
    let cleaned = shiny.replace_all(name, "");
    let cleaned = rare_holo.replace_all(&cleaned, "");
    let cleaned = holo.replace_all(&cleaned, "");
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    slug_part(collapsed.trim())
}

/// `normalizedCollectorNumber(value)`.
pub(crate) fn normalized_collector_number(value: &str) -> String {
    static SLASH: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SPECIAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static STAMP: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static PLAIN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let slash =
        SLASH.get_or_init(|| regex::Regex::new(r"(?i)([A-Z]*\d+[A-Z]?\s*/\s*\d+)").unwrap());
    let special = SPECIAL.get_or_init(|| regex::Regex::new(r"(?i)\b([A-Z]{1,4}\s*\d+)\b").unwrap());
    let stamp = STAMP.get_or_init(|| regex::Regex::new(r"(?i)\bStamp Number\s+(\d+)\b").unwrap());
    let plain = PLAIN.get_or_init(|| regex::Regex::new(r"(?i)\b(?:No\.)?0*(\d{1,4})\b").unwrap());

    let text = value.replace("||", "|");
    let text = text.trim();
    if let Some(caps) = slash.captures(text) {
        return caps[1].split_whitespace().collect::<String>();
    }
    if let Some(caps) = special.captures(text) {
        return caps[1].split_whitespace().collect::<String>();
    }
    if let Some(caps) = stamp.captures(text) {
        return caps[1].to_owned();
    }
    if let Some(caps) = plain.captures(text) {
        return caps[1].to_owned();
    }
    text.to_owned()
}

/// `unique(values.filter(Boolean))`.
fn unique_nonempty(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        if value.is_empty() || out.contains(&value) {
            continue;
        }
        out.push(value);
    }
    out
}

/// Pad with leading zeros the way `String(value).padStart(2|3, '0')` does.
fn pad_start(value: i64, width: usize) -> String {
    let text = value.to_string();
    if text.len() >= width {
        text
    } else {
        format!("{}{}", "0".repeat(width - text.len()), text)
    }
}

/// A `candidateUrls` input row; empty string reads as the JS `undefined`/`''`
/// the reference code treats identically.
#[derive(Debug, Clone, Default)]
pub(crate) struct RedirectRow {
    pub card_id: String,
    pub name: String,
    pub expansion_name: String,
    pub expansion_number: String,
    pub product_variant: String,
    pub inferred_product_variant: String,
    pub card_type: String,
    pub cardmarket_set_code: String,
    pub cardmarket_expansion_slug: String,
    pub expansion_code: String,
}

/// `maybeCardmarketSetCode(row)`.
pub(crate) fn maybe_cardmarket_set_code(row: &RedirectRow) -> String {
    let stored = row.cardmarket_set_code.trim();
    if !stored.is_empty() {
        return stored.to_owned();
    }
    let expansion_name = row.expansion_name.trim();
    if let Some(known) = known_cardmarket_set_code(expansion_name) {
        return known.to_owned();
    }
    let code: String = row
        .expansion_code
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    code.to_uppercase()
}

/// `expansionSlug(row)`.
pub(crate) fn expansion_slug(row: &RedirectRow) -> String {
    let stored = row.cardmarket_expansion_slug.trim();
    if !stored.is_empty() {
        return stored.to_owned();
    }
    let expansion_name = row.expansion_name.trim();
    if let Some(known) = known_cardmarket_expansion_slug(expansion_name) {
        return known.to_owned();
    }
    slug_part(expansion_name)
}

/// `collectorCandidates(collectorNumber, setCode)`.
pub(crate) fn collector_candidates(collector_number: &str, set_code: &str) -> Vec<String> {
    let raw = normalized_collector_number(collector_number);
    if raw.is_empty() || set_code.is_empty() {
        return vec![];
    }
    let no_slash = match raw.find('/') {
        Some(index) => raw[..index].to_owned(),
        None => raw.clone(),
    };
    let clean: String = no_slash
        .split_whitespace()
        .collect::<String>()
        .to_uppercase();
    if !clean.chars().any(|ch| ch.is_ascii_digit()) {
        return vec![];
    }

    static SPECIAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static NUMERIC: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let special = SPECIAL.get_or_init(|| regex::Regex::new(r"^([A-Z]+)(\d+)$").unwrap());
    let numeric = NUMERIC.get_or_init(|| regex::Regex::new(r"^0*(\d+)[A-Z]?$").unwrap());

    if let Some(caps) = special.captures(&clean) {
        let prefix = &caps[1];
        let numeric_text = &caps[2];
        let value: Option<i64> = numeric_text.parse().ok();
        let padded2 = value
            .map(|v| pad_start(v, 2))
            .unwrap_or_else(|| numeric_text.to_owned());
        let padded3 = value
            .map(|v| pad_start(v, 3))
            .unwrap_or_else(|| numeric_text.to_owned());
        // Promo numbers carry their own printed code (`SM201`). Cardmarket
        // SM-promo slugs are per-product inconsistent: raw code, doubled
        // prefix and set code + plain number all exist — offer all three.
        return unique_nonempty(vec![
            format!("{prefix}{numeric_text}"),
            format!("{prefix}{clean}"),
            format!("{set_code}{numeric_text}"),
            format!("{set_code}{prefix}{padded2}"),
            format!("{set_code}{prefix}{numeric_text}"),
            format!("{set_code}{prefix}{padded3}"),
        ]);
    }
    if let Some(caps) = numeric.captures(&clean) {
        let value: i64 = match caps[1].parse() {
            Ok(value) => value,
            Err(_) => return vec![format!("{set_code}{clean}")],
        };
        let suffix = leading_digits_stripped(&clean);
        let unpadded = format!("{set_code}{value}{suffix}");
        let padded3 = format!("{set_code}{}{suffix}", pad_start(value, 3));
        let padded2 = format!("{set_code}{}{suffix}", pad_start(value, 2));
        return if clean.starts_with('0') {
            unique_nonempty(vec![padded3, unpadded, padded2])
        } else {
            unique_nonempty(vec![unpadded, padded3, padded2])
        };
    }
    vec![format!("{set_code}{clean}")]
}

/// `clean.replace(/^\d+/, '')` — strip only the leading digit run.
fn leading_digits_stripped(text: &str) -> String {
    let split = text
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii_digit())
        .map(|(index, _)| index)
        .unwrap_or(text.len());
    text[split..].to_owned()
}

/// `likelyNameOnlyCardmarketSlug(row)`.
pub(crate) fn likely_name_only_cardmarket_slug(row: &RedirectRow) -> bool {
    static TRAINER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let trainer = TRAINER.get_or_init(|| {
        regex::Regex::new(r"\b(trainer|supporter|item|stadium|tool|special energy|energy)\b")
            .unwrap()
    });
    let card_type = row.card_type.to_lowercase();
    if trainer.is_match(&card_type) {
        known_name_only_trainer_expansion(row.expansion_name.trim())
    } else {
        false
    }
}

/// `cardmarketVersionMarkers(row)`.
pub(crate) fn cardmarket_version_markers(row: &RedirectRow) -> Vec<String> {
    static V: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let marker_re = V.get_or_init(|| regex::Regex::new(r"(?i)^v\d+$").unwrap());
    let mut markers: Vec<String> = Vec::new();
    let version = row.product_variant.trim();
    if marker_re.is_match(version) {
        markers.push(version.to_uppercase());
    }
    let inferred = row.inferred_product_variant.trim();
    if marker_re.is_match(inferred) {
        markers.push(inferred.to_uppercase());
    }
    // The empty marker is kept: `[...new Set(markers)]` (no truthiness filter).
    markers.push(String::new());
    let mut seen: Vec<String> = Vec::new();
    for marker in markers {
        if !seen.contains(&marker) {
            seen.push(marker);
        }
    }
    seen
}

/// `isMisprintRow(row)`.
pub(crate) fn is_misprint_row(row: &RedirectRow) -> bool {
    strip_diacritics(row.expansion_name.trim()).to_lowercase() == "pokemon misprints"
}

/// `candidateUrls(row, locale)`.
pub(crate) fn candidate_urls(row: &RedirectRow, locale: &str) -> Vec<String> {
    if is_misprint_row(row) {
        return vec![];
    }
    if let Some(verified) = verified_blueprint_url(row.card_id.trim()) {
        return vec![verified.to_owned()];
    }
    let set_code = maybe_cardmarket_set_code(row);
    let expansion = expansion_slug(row);
    let name = card_name_slug(&row.name);
    let product_codes = collector_candidates(&row.expansion_number, &set_code);
    let version_markers = cardmarket_version_markers(row);
    let name_only_candidate =
        format!("https://www.cardmarket.com/{locale}/Pokemon/Products/Singles/{expansion}/{name}");
    let mut candidates: Vec<String> = Vec::new();
    if likely_name_only_cardmarket_slug(row) {
        candidates.push(name_only_candidate.clone());
    }
    for product_code in &product_codes {
        for marker in &version_markers {
            let slug = [name.as_str(), marker.as_str(), product_code.as_str()]
                .iter()
                .filter(|part| !part.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("-");
            candidates.push(format!(
                "https://www.cardmarket.com/{locale}/Pokemon/Products/Singles/{expansion}/{slug}"
            ));
        }
    }
    candidates.push(name_only_candidate);
    unique_nonempty(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_part_matches_cardmarket_rules() {
        assert_eq!(
            slug_part("Reshiram & Charizard GX"),
            "Reshiram-Charizard-GX"
        );
        assert_eq!(slug_part("Hop's Zacian ex"), "Hops-Zacian-ex");
        assert_eq!(slug_part("Pokémon Center"), "Pokemon-Center");
        assert_eq!(slug_part(""), "");
        assert_eq!(slug_part("Call of Legends"), "Call-of-Legends");
    }

    #[test]
    fn card_name_slug_strips_rarity_words() {
        assert_eq!(card_name_slug("Pikachu Holo"), "Pikachu");
        assert_eq!(card_name_slug("Zard Rare Holo V"), "Zard-V");
        assert_eq!(card_name_slug("Moonbreon Shiny Rare"), "Moonbreon");
    }

    #[test]
    fn normalized_collector_number_variants() {
        assert_eq!(normalized_collector_number("184/182"), "184/182");
        assert_eq!(
            normalized_collector_number("Illustration Rare | 184/182"),
            "184/182"
        );
        assert_eq!(normalized_collector_number("No. 025"), "25");
        assert_eq!(normalized_collector_number("SM238"), "SM238");
        assert_eq!(normalized_collector_number("Stamp Number 194"), "194");
        assert_eq!(normalized_collector_number("Prerelease SM158"), "SM158");
        assert_eq!(normalized_collector_number(""), "");
        assert_eq!(normalized_collector_number("weird"), "weird");
    }

    #[test]
    fn collector_candidates_numeric_paths() {
        assert_eq!(
            collector_candidates("58/102", "BS"),
            vec!["BS58", "BS058"]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        );
        // Padded input reorders toward the padded form.
        assert_eq!(
            collector_candidates("058/102", "BS"),
            vec!["BS058", "BS58"]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        );
        assert_eq!(
            collector_candidates("SM201", "OSSM"),
            vec!["SM201", "SMSM201", "OSSM201", "OSSMSM201",]
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        );
        assert!(collector_candidates("", "BS").is_empty());
        assert!(collector_candidates("58", "").is_empty());
        assert!(
            collector_candidates("AB", "BS").is_empty(),
            "no digit -> []"
        );
    }

    #[test]
    fn candidate_urls_prefers_verified_blueprints() {
        let row = RedirectRow {
            card_id: "228478".to_owned(),
            name: "Detective Pikachu".to_owned(),
            expansion_name: "SM Black Star Promos".to_owned(),
            expansion_number: "SM194".to_owned(),
            ..Default::default()
        };
        assert_eq!(
            candidate_urls(&row, "en"),
            vec![
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/SM-Black-Star-Promos/Detective-Pikachu-V2-OSSM194"
                    .to_owned()
            ]
        );
    }

    #[test]
    fn candidate_urls_generate_slug_ladder() {
        let row = RedirectRow {
            card_id: "999".to_owned(),
            name: "Pikachu Holo".to_owned(),
            expansion_name: "Neo Discovery".to_owned(),
            expansion_number: "25/75".to_owned(),
            product_variant: "v2".to_owned(),
            ..Default::default()
        };
        let urls = candidate_urls(&row, "en");
        assert_eq!(
            urls,
            vec![
                // `for productCode { for marker }` — code-outer ordering.
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Pikachu-V2-NDI25",
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Pikachu-NDI25",
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Pikachu-V2-NDI025",
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Pikachu-NDI025",
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Pikachu",
            ]
        );
    }

    #[test]
    fn candidate_urls_skip_misprints() {
        let row = RedirectRow {
            expansion_name: "Pokemon Misprints".to_owned(),
            name: "Odd".to_owned(),
            ..Default::default()
        };
        assert!(candidate_urls(&row, "en").is_empty());
    }

    #[test]
    fn name_only_rows_use_the_trainer_whitelist() {
        let night_unison = RedirectRow {
            name: "Brock".to_owned(),
            expansion_name: "Night Unison".to_owned(),
            expansion_number: "112/113".to_owned(),
            card_type: "trainer".to_owned(),
            ..Default::default()
        };
        let urls = candidate_urls(&night_unison, "en");
        assert_eq!(
            urls,
            vec!["https://www.cardmarket.com/en/Pokemon/Products/Singles/Night-Unison/Brock"]
        );
        let other_trainer = RedirectRow {
            name: "Brock".to_owned(),
            expansion_name: "Some Other Set".to_owned(),
            expansion_number: "1/2".to_owned(),
            card_type: "trainer".to_owned(),
            ..Default::default()
        };
        // Not in the known-slug map and not name-only whitelisted -> the
        // product-code ladder still runs from the slugified expansion.
        let urls = candidate_urls(&other_trainer, "en");
        assert_eq!(
            urls,
            vec![
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/Some-Other-Set/Brock"
                    .to_owned()
            ],
            "no known set code -> product-code ladder is empty, only the name-only slug"
        );
    }
}
