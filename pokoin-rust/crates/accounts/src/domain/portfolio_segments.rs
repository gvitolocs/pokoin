//! Portfolio segments: which holding belongs to which line on the dashboard.
//!
//! The history series prices the whole collection into one value; a *segment*
//! is a slice of it that can be drawn on its own — a Pokémon era, sealed
//! product, graded slabs, or a non-Pokémon game. A key is an opaque string that
//! only travels from here to the client and back; nothing parses it again.
//!
//! The era split lives in `BANDS` alone, so moving one era is a one-line change
//! and `SEGMENTS_REVISION` says when the stored per-segment days must be
//! rebuilt because of it.
//!
//! Everything here is pure, so the grouping is testable without a database.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value as Json};

use crate::domain::portfolio_history::{field_bool, field_str, holding_slices, Holding};
use crate::handlers::poko_market::era_for_code;

/// Bump it when the table below or the rules in `segment_keys` change: the
/// stored per-segment days are then rebuilt. The totals are not touched.
pub const SEGMENTS_REVISION: i64 = 1;

/// One Pokémon era band: what the dashboard calls it and which catalog eras
/// fall inside it.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Band {
    id: &'static str,
    label: &'static str,
    years: &'static str,
    /// The names `era_for_code` answers with for this band.
    eras: &'static [&'static str],
}

/// The band that takes everything the table does not place: promos, subsets and
/// a holding whose set is unknown. Every Pokémon row lands in exactly one band,
/// so the era segments add up to the Pokémon total.
const OTHER_BAND: Band = Band {
    id: "other",
    label: "Promos and other",
    years: "",
    eras: &[],
};

const BANDS: [Band; 8] = [
    Band {
        id: "vintage",
        label: "Vintage",
        years: "1999–2003",
        eras: &["Wizards of the Coast"],
    },
    Band {
        id: "mid",
        label: "Mid era",
        years: "2003–2013",
        eras: &[
            "EX",
            "Diamond & Pearl",
            "HeartGold & SoulSilver",
            "Black & White",
        ],
    },
    Band {
        id: "xy",
        label: "XY",
        years: "2013–2016",
        eras: &["XY"],
    },
    Band {
        id: "sm",
        label: "Sun & Moon",
        years: "2017–2019",
        eras: &["Sun & Moon"],
    },
    Band {
        id: "swsh",
        label: "Sword & Shield",
        years: "2020–2023",
        eras: &["Sword & Shield"],
    },
    Band {
        id: "sv",
        label: "Scarlet & Violet",
        years: "2023–2025",
        eras: &["Scarlet & Violet"],
    },
    Band {
        id: "post-sv",
        label: "After Scarlet & Violet",
        years: "2025–",
        eras: &["Mega Evolution"],
    },
    OTHER_BAND,
];

const POKEMON: &str = "pokemon";
const GAME_PREFIX: &str = "game:";
const ERA_PREFIX: &str = "pokemon:era:";
const ALL_SEALED: &str = "all:sealed";
const ALL_GRADED: &str = "all:graded";
const POKEMON_SEALED: &str = "pokemon:sealed";
const POKEMON_GRADED: &str = "pokemon:graded";

/// A product that is not one of these is sealed. `card` is what a row without a
/// `product_type` means; jumbo and accessory printings are singles too.
const LOOSE_PRODUCT_TYPES: [&str; 3] = ["card", "jumbo", "accessory"];

/// The game a holdings row belongs to, lower-cased; Pokémon when it says nothing.
fn game_of(row: &Json) -> String {
    let game = field_str(row, "game").trim().to_ascii_lowercase();
    if game.is_empty() {
        POKEMON.to_string()
    } else {
        game
    }
}

/// Sealed product: what the listing itself says, or a catalog product type that
/// is not a loose card.
fn sealed_of(row: &Json) -> bool {
    if field_bool(row, &["listed_sealed"]) {
        return true;
    }
    let product_type = field_str(row, "product_type").trim().to_ascii_lowercase();
    let product_type = if product_type.is_empty() {
        "card"
    } else {
        &product_type
    };
    !LOOSE_PRODUCT_TYPES.contains(&product_type)
}

/// The era band a set code falls in, `other` when the catalog reports no era or
/// no band lists it.
fn band_of(set_code: &str) -> Band {
    let era = era_for_code(set_code.trim());
    for band in BANDS {
        if band.eras.is_empty() {
            continue;
        }
        if let Some(name) = era {
            if band.eras.contains(&name) {
                return band;
            }
        }
    }
    OTHER_BAND
}

/// Every segment key one holdings row belongs to: its game, the sealed and
/// graded cuts across games, and — for Pokémon — exactly one era band.
pub fn segment_keys(row: &Json) -> Vec<String> {
    let game = game_of(row);
    let pokemon = game == POKEMON;
    let mut keys = vec![format!("{GAME_PREFIX}{game}")];
    if sealed_of(row) {
        keys.push(ALL_SEALED.to_string());
        if pokemon {
            keys.push(POKEMON_SEALED.to_string());
        }
    }
    if field_bool(row, &["graded"]) {
        keys.push(ALL_GRADED.to_string());
        if pokemon {
            keys.push(POKEMON_GRADED.to_string());
        }
    }
    if pokemon {
        keys.push(format!(
            "{ERA_PREFIX}{}",
            band_of(&field_str(row, "set_code")).id
        ));
    }
    keys
}

/// Holdings rows grouped per segment key, each group in the shape the price book
/// is looked up with. A zero-quantity row drops out in `holding_slices`.
pub fn segment_holdings(rows: &[Json]) -> BTreeMap<String, Vec<Holding>> {
    let mut grouped: BTreeMap<String, Vec<Json>> = BTreeMap::new();
    for row in rows {
        for key in segment_keys(row) {
            grouped.entry(key).or_default().push(row.clone());
        }
    }
    grouped
        .into_iter()
        .map(|(key, rows)| (key, holding_slices(&rows)))
        .collect()
}

/// The ordered segments the client draws, or nothing when no day carries any.
///
/// The sealed / graded cuts and the eight era bands are always listed, so the
/// dashboard order never depends on what happens to be held; a game row appears
/// only when some day actually carries that game.
pub fn segment_defs(days: &[Json]) -> Vec<Json> {
    let mut games: BTreeSet<&str> = BTreeSet::new();
    let mut found = false;
    for day in days {
        let Some(segments) = day.get("segments").and_then(Json::as_object) else {
            continue;
        };
        if segments.is_empty() {
            continue;
        }
        found = true;
        for key in segments.keys() {
            if let Some(game) = key.strip_prefix(GAME_PREFIX) {
                games.insert(game);
            }
        }
    }
    if !found {
        return Vec::new();
    }
    let game_def = |game: &str| {
        json!({
            "key": format!("{GAME_PREFIX}{game}"),
            "group": "game",
            "game": game,
        })
    };
    let mut defs: Vec<Json> = games
        .iter()
        .filter(|game| **game != POKEMON)
        .map(|game| game_def(game))
        .collect();
    // The collection's own game leads, whatever else is held.
    if games.contains(POKEMON) {
        defs.insert(0, game_def(POKEMON));
    }
    for (key, label) in [(ALL_SEALED, "Sealed"), (ALL_GRADED, "Graded")] {
        defs.push(json!({
            "key": key,
            "group": "type",
            "game": "all",
            "label": label,
        }));
    }
    for band in BANDS {
        defs.push(json!({
            "key": format!("{ERA_PREFIX}{}", band.id),
            "group": "era",
            "game": POKEMON,
            "label": band.label,
            "years": band.years,
        }));
    }
    for (key, label) in [(POKEMON_SEALED, "Sealed"), (POKEMON_GRADED, "Graded")] {
        defs.push(json!({
            "key": key,
            "group": "type",
            "game": POKEMON,
            "label": label,
        }));
    }
    defs
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A raw Pokémon single of one set, as the holdings query reports it.
    fn single(blueprint: &str, set_code: &str) -> Json {
        json!({
            "blueprint_id": blueprint, "condition": "NM", "language": "EN",
            "reverse": false, "first_edition": false, "graded": false,
            "quantity": 1, "since": "2026-10-01", "game": "pokemon",
            "set_code": set_code, "product_type": "card", "listed_sealed": false
        })
    }

    fn keys_of(row: &Json) -> Vec<String> {
        segment_keys(row)
    }

    fn has(keys: &[String], key: &str) -> bool {
        keys.iter().any(|found| found == key)
    }

    /// Codes spanning every era the catalog reports, plus ones it does not.
    const REPRESENTATIVE_CODES: [&str; 34] = [
        "base1", "gym2", "neo3", "ecard1", "ex7", "pop3", "dp4", "pl2", "hgss1", "col1", "bw9",
        "dv1", "xy8", "g1", "dc1", "sm35", "sma", "smp", "det1", "swsh12tg", "cel25", "pgo",
        "sv3pt5", "zsv10pt5", "rsv10pt5", "sve", "me2pt5", "mee", "mep", "M", "SV", "S", "zzz9",
        "",
    ];

    #[test]
    fn every_era_the_catalog_reports_is_listed_by_a_band() {
        let mut reached: Vec<&str> = Vec::new();
        for code in REPRESENTATIVE_CODES {
            let Some(era) = era_for_code(code) else {
                continue;
            };
            reached.push(era);
            assert!(
                BANDS.iter().any(|band| band.eras.contains(&era)),
                "era_for_code({code:?}) reports {era:?}, which no BANDS row lists"
            );
        }
        assert!(
            reached.len() > 8,
            "the representative codes stopped covering the eras"
        );
        // Every listed era name is reached by some code, so a row that stops
        // matching anything shows up here instead of silently going to `other`.
        for band in BANDS {
            for era in band.eras {
                assert!(
                    reached.contains(era),
                    "no representative code reaches {era:?} any more"
                );
            }
        }
    }

    #[test]
    fn each_era_band_holds_the_singles_of_its_own_codes() {
        for (code, band) in [
            ("base1", "vintage"),
            ("gym2", "vintage"),
            ("ex7", "mid"),
            ("dp4", "mid"),
            ("hgss1", "mid"),
            ("bw9", "mid"),
            ("xy8", "xy"),
            ("sm35", "sm"),
            ("swsh12tg", "swsh"),
            ("sv3pt5", "sv"),
            ("me2pt5", "post-sv"),
            ("pop1", "mid"),
            ("pl1", "mid"),
            ("sve", "sv"),
            ("mep1", "other"),
        ] {
            let keys = keys_of(&single("1", code));
            assert!(
                has(&keys, &format!("pokemon:era:{band}")),
                "{code} landed in {keys:?}, not in {band}"
            );
            assert_eq!(keys.len(), 2, "{code}: {keys:?}");
        }
    }

    #[test]
    fn an_unknown_or_empty_set_code_is_promos_and_other() {
        for code in ["zzz9", "", "   "] {
            let keys = keys_of(&single("1", code));
            assert_eq!(keys, vec!["game:pokemon", "pokemon:era:other"], "{code:?}");
        }
        // A row whose set code the catalog cannot place still counts once.
        assert_eq!(
            keys_of(&single("1", "M")),
            vec!["game:pokemon", "pokemon:era:post-sv"]
        );
    }

    #[test]
    fn sealed_rows_take_both_sealed_keys_and_keep_their_era() {
        let box_row = json!({
            "blueprint_id": "7", "quantity": 2, "since": "2026-10-01",
            "game": "pokemon", "set_code": "sv1", "product_type": "booster_box",
            "graded": false
        });
        assert_eq!(
            keys_of(&box_row),
            vec![
                "game:pokemon",
                "all:sealed",
                "pokemon:sealed",
                "pokemon:era:sv"
            ]
        );
        // A listing the seller marked sealed, whatever its product type says.
        let listed = json!({
            "blueprint_id": "7", "quantity": 1, "game": "pokemon", "set_code": "ex1",
            "product_type": "card", "listed_sealed": true
        });
        assert_eq!(
            keys_of(&listed),
            vec![
                "game:pokemon",
                "all:sealed",
                "pokemon:sealed",
                "pokemon:era:mid"
            ]
        );
        // Deck boxes and stuff that is not a loose card at all.
        for product_type in ["booster_pack", "team_battle_deck", "binder", "other"] {
            let row = json!({ "game": "pokemon", "product_type": product_type });
            assert!(
                has(&keys_of(&row), "pokemon:sealed"),
                "{product_type} counted as a loose card"
            );
        }
    }

    #[test]
    fn accessory_and_jumbo_are_not_sealed() {
        for product_type in ["accessory", "jumbo", "card"] {
            let row = json!({
                "blueprint_id": "7", "quantity": 1, "game": "pokemon",
                "set_code": "sv1", "product_type": product_type
            });
            let keys = keys_of(&row);
            assert!(!has(&keys, "all:sealed"), "{product_type} sealed");
            assert!(!has(&keys, "pokemon:sealed"), "{product_type} sealed");
            assert_eq!(keys.len(), 2, "{product_type}: {keys:?}");
        }
        // A missing product type means a card, so it is not sealed either.
        let keys = keys_of(&json!({ "game": "pokemon", "set_code": "sv1" }));
        assert!(!has(&keys, "all:sealed"));
    }

    #[test]
    fn a_graded_row_takes_both_graded_keys() {
        let row = json!({
            "blueprint_id": "7", "quantity": 1, "game": "pokemon",
            "set_code": "base1", "graded": true
        });
        assert_eq!(
            keys_of(&row),
            vec![
                "game:pokemon",
                "all:graded",
                "pokemon:graded",
                "pokemon:era:vintage"
            ]
        );
        // Graded sealed product takes all four cuts.
        let row = json!({
            "blueprint_id": "7", "game": "pokemon", "set_code": "base1",
            "product_type": "booster_box", "graded": true
        });
        assert_eq!(
            keys_of(&row),
            vec![
                "game:pokemon",
                "all:sealed",
                "pokemon:sealed",
                "all:graded",
                "pokemon:graded",
                "pokemon:era:vintage"
            ]
        );
    }

    #[test]
    fn another_game_never_lands_in_a_pokemon_segment() {
        let row = json!({ "blueprint_id": "", "quantity": 1, "game": "Riftbound" });
        assert_eq!(keys_of(&row), vec!["game:riftbound"]);
        let row = json!({
            "blueprint_id": "", "quantity": 1, "game": "riftbound",
            "set_code": "sv1", "product_type": "booster_box", "graded": true
        });
        assert_eq!(
            keys_of(&row),
            vec!["game:riftbound", "all:sealed", "all:graded"]
        );
        // The set code is Pokémon-only: a riftbound row ignores it.
        for key in keys_of(&row) {
            assert!(!key.starts_with("pokemon:"), "{key}");
        }
    }

    #[test]
    fn a_row_without_a_game_is_pokemon() {
        let keys = keys_of(&json!({ "blueprint_id": "7", "quantity": 1 }));
        assert_eq!(keys, vec!["game:pokemon", "pokemon:era:other"]);
        assert_eq!(keys_of(&json!({ "game": "" })), keys);
        assert_eq!(keys_of(&json!({ "game": "  " })), keys);
    }

    #[test]
    fn segment_holdings_groups_quantities_and_drops_zero_rows() {
        let rows = vec![
            single("100", "base1"),
            {
                let mut another = single("100", "base1");
                another["quantity"] = json!(3);
                another
            },
            single("200", "sv1"),
            {
                // A sold-through slice of a band nobody else holds.
                let mut none = single("300", "xy1");
                none["quantity"] = json!(0);
                none
            },
        ];
        let groups = segment_holdings(&rows);
        let vintage = &groups["pokemon:era:vintage"];
        assert_eq!(vintage.len(), 2);
        assert_eq!(vintage.iter().map(|holding| holding.qty).sum::<i64>(), 4);
        assert_eq!(groups["game:pokemon"].len(), 3);
        assert_eq!(groups["pokemon:era:sv"].len(), 1);
        // The only xy row had quantity 0, so the band holds nothing.
        assert!(groups["pokemon:era:xy"].is_empty());
        for holding in groups.values().flatten() {
            assert!(holding.qty > 0);
        }
        assert!(!groups.contains_key("all:sealed"));
    }

    #[test]
    fn segment_defs_is_empty_until_a_day_carries_segments() {
        assert!(segment_defs(&[]).is_empty());
        assert!(segment_defs(&[json!({ "date": "2026-10-08" })]).is_empty());
        // An empty object is not a segment either.
        assert!(segment_defs(&[json!({ "date": "2026-10-08", "segments": {} })]).is_empty());
        assert!(!segment_defs(&[json!({ "segments": { "game:pokemon": [1, 1, 1] } })]).is_empty());
    }

    #[test]
    fn segment_defs_lists_games_then_types_then_the_era_bands() {
        let days = vec![
            json!({ "segments": { "game:pokemon": [1, 1, 1], "game:riftbound": [2, 1, 1] } }),
            // The same game key in another day is still listed once.
            json!({ "segments": { "game:riftbound": [3, 1, 1], "pokemon:era:sv": [3, 1, 1] } }),
        ];
        let defs = segment_defs(&days);
        let keys: Vec<&str> = defs
            .iter()
            .map(|def| def["key"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            keys,
            vec![
                "game:pokemon",
                "game:riftbound",
                "all:sealed",
                "all:graded",
                "pokemon:era:vintage",
                "pokemon:era:mid",
                "pokemon:era:xy",
                "pokemon:era:sm",
                "pokemon:era:swsh",
                "pokemon:era:sv",
                "pokemon:era:post-sv",
                "pokemon:era:other",
                "pokemon:sealed",
                "pokemon:graded",
            ]
        );
        assert_eq!(
            defs[0],
            json!({ "key": "game:pokemon", "group": "game", "game": "pokemon" })
        );
        assert_eq!(
            defs[1],
            json!({ "key": "game:riftbound", "group": "game", "game": "riftbound" })
        );
        assert_eq!(
            defs[2],
            json!({ "key": "all:sealed", "group": "type", "game": "all", "label": "Sealed" })
        );
        assert_eq!(
            defs[3],
            json!({ "key": "all:graded", "group": "type", "game": "all", "label": "Graded" })
        );
        // Every band is listed even though only SV is held, with its own label.
        assert_eq!(
            defs[4],
            json!({
                "key": "pokemon:era:vintage", "group": "era", "game": "pokemon",
                "label": "Vintage", "years": "1999–2003"
            })
        );
        assert_eq!(
            defs[9],
            json!({
                "key": "pokemon:era:sv", "group": "era", "game": "pokemon",
                "label": "Scarlet & Violet", "years": "2023–2025"
            })
        );
        assert_eq!(
            defs[11],
            json!({
                "key": "pokemon:era:other", "group": "era", "game": "pokemon",
                "label": "Promos and other", "years": ""
            })
        );
        assert_eq!(
            defs[12],
            json!({ "key": "pokemon:sealed", "group": "type", "game": "pokemon", "label": "Sealed" })
        );
        assert_eq!(
            defs[13],
            json!({ "key": "pokemon:graded", "group": "type", "game": "pokemon", "label": "Graded" })
        );
    }

    #[test]
    fn segment_defs_sorts_the_other_games_by_id() {
        let days = vec![json!({
            "segments": { "game:riftbound": [1, 1, 1], "game:onepiece": [1, 1, 1] }
        })];
        let defs = segment_defs(&days);
        let games: Vec<&str> = defs
            .iter()
            .filter(|def| def["group"] == json!("game"))
            .map(|def| def["game"].as_str().unwrap_or_default())
            .collect();
        // The other games follow in id order, whether or not Pokémon is held.
        assert_eq!(games, vec!["onepiece", "riftbound"]);
    }
}
