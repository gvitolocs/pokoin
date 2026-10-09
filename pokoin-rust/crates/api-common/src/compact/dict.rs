//! The versioned, append-only numeric code tables served by
//! `GET /api/dictionary`, adapted from CardRail's `backend/src/codes.rs`.
//!
//! # The append-only contract
//!
//! A code is `index + 1` inside its table, and `0` is never a valid code.
//! Entries are **only ever appended**. An entry is never renumbered, reordered
//! or removed, because a compact (`c1`) payload that a client decoded with an
//! older snapshot of a table must keep decoding to the same strings forever.
//! Retiring a value means leaving it in place, not deleting the row.
//!
//! [`VERSION`] is bumped whenever a table gains entries. A `c1` payload carries
//! the version it was encoded against so a client holding an older snapshot can
//! tell the difference between "a code I have not seen" and silent corruption.
//!
//! Unknown values are not an error: the encoder keeps them as literal strings
//! in the per-response palette (see [`super::encode`]), so a value that is not
//! in a table only costs its own bytes.

use serde_json::{json, Map, Value};

/// Dictionary version. **Bump this whenever a table below gains entries.**
///
/// Append-only means an older client can always decode a newer payload's codes
/// for entries it already knows; the version tells it when to refetch.
pub const VERSION: &str = "1";

/// Games Pokoin serves from the shared API. `pokemon` is code 1; the rest
/// follow `pokoin_api_common::game::INGEST_GAMES` in its declared order.
pub const GAMES: &[&str] = &[
    "pokemon",
    "magic",
    "yugioh",
    "flesh_and_blood",
    "digimon",
    "dragon_ball_super",
    "vanguard",
    "one_piece",
    "lorcana",
    "star_wars",
    "union_arena",
    "riftbound",
    "gundam",
    "sorcery",
    "palworld",
    "cyberpunk",
    "weiss_schwarz",
    "final_fantasy",
    "force_of_will",
    "world_of_warcraft",
    "battle_spirits_saga",
    "star_wars_destiny",
    "dragon_born",
    "my_little_pony",
    "the_spoils",
];

/// Card / listing languages, in `market/src/locale.js` `SEARCH_LANGS` order
/// (uppercased, which is how listings and sold rows store them).
pub const LANGUAGES: &[&str] = &[
    "EN", "IT", "FR", "DE", "ES", "JP", "PT", "NL", "PL", "RU", "KO", "ZH", "ZHT", "ID", "TH", "VI",
];

/// Grades of the condition ladder, best first
/// (`catalog-api` `sales::core::SOLD_CONDITION_ORDER` plus `M`).
pub const CONDITIONS: &[&str] = &["M", "NM", "SP", "MP", "PL", "Poor"];

/// `foil_state` of `marketplace_user_listings`.
pub const PRINTINGS: &[&str] = &["standard", "reverse", "holo", "first_edition_holo"];

/// Print nationalities — `market/src/print-bucket.js` `PRINT_BUCKETS`.
pub const NATIONALITIES: &[&str] = &[
    "western",
    "japanese",
    "korean",
    "chinese",
    "indonesian",
    "thai",
    "idth",
    "unknown",
    "product",
];

/// Artist-album artwork layouts — `market/src/art-layout.js` `ART_LAYOUTS`.
pub const ART_LAYOUTS: &[&str] = &["window", "bleed", "landscape", "item", "halfart"];

/// `rarityKind` of `toReactCard` (only these three are kept; anything else is
/// flattened to `""`).
pub const RARITY_KINDS: &[&str] = &["rainbow", "gold", "ghost"];

/// `item_kind` of `marketplace_search_candidates`.
pub const ITEM_KINDS: &[&str] = &["single", "product"];

/// `product_type` of `marketplace_search_candidates` / the search-page facets.
pub const PRODUCT_TYPES: &[&str] = &[
    "card",
    "jumbo",
    "sealed_product",
    "booster_box",
    "booster_pack",
    "booster_bundle",
    "collection_box",
    "elite_trainer_box",
    "deck",
    "tin",
    "accessory",
    "bundle",
];

/// Canonical CardTrader / catalog rarity names. This table is deliberately
/// partial: `rarity` is free text in the catalog (set-specific stamps, WCD
/// years, bare collector numbers), so anything missing stays a literal string
/// in the per-response palette.
pub const RARITIES: &[&str] = &[
    "Card",
    "Common",
    "Uncommon",
    "Rare",
    "Holo Rare",
    "Ultra Rare",
    "Secret Rare",
    "Gold Secret Rare",
    "Illustration Rare",
    "Special Illustration Rare",
    "Shiny Rare",
    "Amazing Rare",
    "Full-Art",
    "Promo",
    "Holo Promo",
    "Non-Holo",
    "Non-Holo Promo",
    "Reverse Holo",
    "Cosmos Holo",
    "Cracked Ice Holo",
    "Master Ball Reverse Holo",
    "Poké Ball Reverse Holo",
    "Shadowless",
    "No Rarity",
    "No Rarity Holo",
    "Jumbo Oversized",
    "Fixed",
];

/// Listing bit flags. The value is the bit, not an index, so a flag set
/// serialises as one integer.
pub const FLAGS: &[(&str, u32)] = &[
    ("firstEdition", 1),
    ("signed", 2),
    ("altered", 4),
    ("reverse", 8),
    ("graded", 16),
    ("sealed", 32),
    ("nftAvailable", 64),
    ("shippingAvailable", 128),
    ("reserveAvailable", 256),
];

/// URL prefixes a `c1` column may reference by index instead of repeating the
/// literal. Append-only like every other table.
pub const URL_PREFIXES: &[&str] = &[
    "https://cdn.pokoin.com/",
    "https://cdn.pokoin.com/card-images/",
    "https://cdn.pokoin.com/card-images/previews/",
    "https://cdn.pokoin.com/expansions/symbols/",
    "https://cdn.pokoin.com/expansions/logos/",
    "/card-images/",
    "/card-images/previews/",
    "/marketplace/en/cards/",
    "/marketplace/",
];

/// The tables a `c1` column may be coded against, by table name.
pub const TABLES: &[(&str, &[&str])] = &[
    ("games", GAMES),
    ("languages", LANGUAGES),
    ("conditions", CONDITIONS),
    ("printings", PRINTINGS),
    ("nationalities", NATIONALITIES),
    ("artLayouts", ART_LAYOUTS),
    ("rarityKinds", RARITY_KINDS),
    ("itemKinds", ITEM_KINDS),
    ("productTypes", PRODUCT_TYPES),
    ("rarities", RARITIES),
];

/// The table a column of this name is coded against, if any. Both the
/// camelCase and the snake_case spelling of every aliased field map to the
/// same table, so an alias pair codes identically and can still be `ref`-ed.
pub fn table_for_key(key: &str) -> Option<&'static str> {
    Some(match key {
        "game" | "marketplaceGame" | "marketplace_game" => "games",
        "language" | "card_language" | "cardLanguage" | "print_language" | "printLanguage" => {
            "languages"
        }
        "condition" => "conditions",
        "printing" | "foilState" | "foil_state" => "printings",
        "nationality" => "nationalities",
        "artLayout" | "art_layout" => "artLayouts",
        "rarityKind" | "rarity_kind" => "rarityKinds",
        "itemKind" | "item_kind" => "itemKinds",
        "productType" | "product_type" => "productTypes",
        "rarity" | "localized_rarity" | "localizedRarity" => "rarities",
        _ => return None,
    })
}

/// `code - 1` as an index into a table, or `None` for `0`/out of range.
pub fn entry(table: &str, code: u32) -> Option<&'static str> {
    let values = TABLES.iter().find(|(name, _)| *name == table)?.1;
    let index = usize::try_from(code.checked_sub(1)?).ok()?;
    values.get(index).copied()
}

/// The `index + 1` code of a value, or `None` when the table does not have it.
pub fn code(table: &str, value: &str) -> Option<u32> {
    let values = TABLES.iter().find(|(name, _)| *name == table)?.1;
    let index = values.iter().position(|entry| *entry == value)?;
    u32::try_from(index + 1).ok()
}

/// The `index + 1` code of a URL prefix, or `None`.
pub fn url_prefix_code(prefix: &str) -> Option<u32> {
    let index = URL_PREFIXES.iter().position(|entry| *entry == prefix)?;
    u32::try_from(index + 1).ok()
}

/// The URL prefix a code names.
pub fn url_prefix(code: u32) -> Option<&'static str> {
    let index = usize::try_from(code.checked_sub(1)?).ok()?;
    URL_PREFIXES.get(index).copied()
}

/// The `GET /api/dictionary` body. Every table is emitted as a dense array
/// whose code is `index + 1`.
pub fn document() -> Value {
    let mut tables = Map::new();
    for (name, values) in TABLES {
        tables.insert((*name).to_string(), json!(values));
    }
    let mut flags = Map::new();
    for (name, bit) in FLAGS {
        flags.insert((*name).to_string(), json!(bit));
    }
    json!({
        "version": VERSION,
        "format": "c1",
        "codeBase": 1,
        "appendOnly": true,
        "tables": Value::Object(tables),
        "flags": Value::Object(flags),
        "urlPrefixes": json!(URL_PREFIXES),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_one_based_and_round_trip() {
        assert_eq!(code("games", "pokemon"), Some(1));
        assert_eq!(entry("games", 1), Some("pokemon"));
        assert_eq!(code("languages", "EN"), Some(1));
        assert_eq!(code("conditions", "NM"), Some(2));
        assert_eq!(entry("conditions", 2), Some("NM"));
        for (table, values) in TABLES {
            for (index, value) in values.iter().enumerate() {
                let found = code(table, value).expect("every entry has a code");
                assert_eq!(found as usize, index + 1);
                assert_eq!(entry(table, found), Some(*value));
            }
        }
    }

    #[test]
    fn zero_and_out_of_range_are_not_codes() {
        assert_eq!(entry("games", 0), None);
        assert_eq!(entry("games", 9_999), None);
        assert_eq!(entry("not-a-table", 1), None);
        assert_eq!(code("games", "not-a-game"), None);
    }

    #[test]
    fn tables_have_no_duplicates() {
        // A duplicate would make two codes decode to the same string and break
        // the "never renumbered" promise the next time one was removed.
        for (table, values) in TABLES {
            let mut seen = std::collections::HashSet::new();
            for value in *values {
                assert!(seen.insert(*value), "{table} repeats {value}");
            }
        }
        let mut seen = std::collections::HashSet::new();
        for prefix in URL_PREFIXES {
            assert!(seen.insert(*prefix), "URL_PREFIXES repeats {prefix}");
        }
    }

    #[test]
    fn games_table_covers_every_ingest_game() {
        for game in crate::game::INGEST_GAMES {
            assert!(
                code("games", game.id).is_some(),
                "games table is missing {}",
                game.id
            );
        }
        assert_eq!(GAMES.len(), crate::game::INGEST_GAMES.len() + 1);
    }

    #[test]
    fn aliased_keys_share_a_table() {
        assert_eq!(table_for_key("artLayout"), table_for_key("art_layout"));
        assert_eq!(table_for_key("productType"), table_for_key("product_type"));
        assert_eq!(table_for_key("name"), None);
    }

    #[test]
    fn flag_bits_are_distinct_powers_of_two() {
        let mut mask = 0u32;
        for (name, bit) in FLAGS {
            assert!(bit.is_power_of_two(), "{name} is not a single bit");
            assert_eq!(mask & bit, 0, "{name} reuses a bit");
            mask |= bit;
        }
    }

    #[test]
    fn document_shape() {
        let doc = document();
        assert_eq!(doc["version"], json!(VERSION));
        assert_eq!(doc["codeBase"], json!(1));
        assert_eq!(doc["tables"]["languages"][0], json!("EN"));
        assert_eq!(doc["flags"]["firstEdition"], json!(1));
        assert_eq!(doc["urlPrefixes"][0], json!("https://cdn.pokoin.com/"));
    }

    /// The browser decoder bundles a snapshot of these tables. If it drifts,
    /// a `c1` payload would decode to different strings in the SPA than the
    /// encoder meant — so the committed snapshot is part of the contract.
    ///
    /// Regenerate with
    /// `cargo run --quiet --example c1_dictionary > ../market/src/compact-dictionary.json`.
    #[test]
    fn the_committed_snapshot_matches_the_tables() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../market/src/compact-dictionary.json"
        );
        let text = std::fs::read_to_string(path).expect("market/src/compact-dictionary.json");
        let committed: Value = serde_json::from_str(&text).expect("snapshot json");
        assert_eq!(
            committed,
            document(),
            "market/src/compact-dictionary.json is stale; \
             rerun `cargo run --quiet --example c1_dictionary`"
        );
    }

    #[test]
    fn url_prefixes_round_trip() {
        for prefix in URL_PREFIXES {
            let code = url_prefix_code(prefix).expect("prefix has a code");
            assert_eq!(url_prefix(code), Some(*prefix));
        }
        assert_eq!(url_prefix(0), None);
        assert_eq!(url_prefix_code("https://example.invalid/"), None);
    }
}
