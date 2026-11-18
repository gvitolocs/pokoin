//! Portfolio segments: which holding belongs to which line on the dashboard.
//!
//! The history series prices the whole collection into one value; a *segment*
//! is a slice of it that can be drawn on its own — a Pokémon era, sealed
//! product, graded slabs, a non-Pokémon game, or one set of such a game. A key
//! is an opaque string that only travels from here to the client and back;
//! nothing parses it again.
//!
//! The era split lives in `BANDS` alone, so moving one era is a one-line change
//! and `SEGMENTS_REVISION` says when the stored per-segment days must be
//! rebuilt because of it.
//!
//! Everything here is pure, so the grouping is testable without a database.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{json, Map, Value as Json};

use crate::domain::marketplace_game::{is_pokemon_ingest_game, normalize_game};
use crate::domain::portfolio_history::{field_bool, field_i64, field_str, holding_slices, Holding};
use crate::handlers::poko_market::era_for_code;

/// Bump it when the table below or the rules in `segment_keys` change: the
/// stored per-segment days are then rebuilt. The totals are not touched.
/// 2: a game id is sanitised before it enters a key (`game_of`).
/// 3: every game is cut into sets as well as sealed / graded, so the stored
///    per-segment days of every game but Pokémon are new lines.
pub const SEGMENTS_REVISION: i64 = 3;

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

/// The collection's own game: the only one cut into era bands instead of sets.
pub const POKEMON: &str = "pokemon";
const GAME_PREFIX: &str = "game:";
const ERA_PREFIX: &str = "pokemon:era:";
const ALL_SEALED: &str = "all:sealed";
const ALL_GRADED: &str = "all:graded";

/// A set key is `<game>:set:<slug>`.
const SET_SEP: &str = ":set:";
/// The set of a game that gets every holding whose own set is not drawn.
const OTHER_SET: &str = "other";
/// The slug of a set nobody named.
const UNKNOWN_SET: &str = "unknown";
/// The label `<game>:set:other` always draws under.
const OTHER_SETS_LABEL: &str = "Other sets";
/// The label `<game>:set:unknown` always draws under: its own name is gone,
/// because the row that made it carried no set name at all.
const UNKNOWN_SET_LABEL: &str = "Unknown set";

/// A product that is not one of these is sealed. `card` is what a row without a
/// `product_type` means; jumbo and accessory printings are singles too.
const LOOSE_PRODUCT_TYPES: [&str; 3] = ["card", "jumbo", "accessory"];

/// The game id of a row the platform cannot name a database for: no query is
/// made for it, so its cards stay held and unpriced rather than being looked up
/// in Pokémon's catalog by a card id that only looks alike.
pub const UNKNOWN_GAME: &str = "unknown";

/// The longest game id a key can carry. Only a nameless game is ever cut, since
/// the ids that survive [`game_of`] come from the platform's own game table.
const GAME_MAX_LEN: usize = 40;

/// The words the key scheme uses for itself: `all:sealed` is the cross-game cut
/// and `game:` is its prefix, so a game called either one stays unnamed.
const RESERVED_GAMES: [&str; 2] = ["all", "game"];

/// The game a holdings row belongs to, as its id in the platform's game table;
/// Pokémon when the row says nothing.
///
/// The id goes through [`normalize_game`] so a listing written `one-piece` is the
/// game the rest of the API resolves a database for, `one_piece`. An id the table
/// does not know is [`UNKNOWN_GAME`] and never [`POKEMON`], because a row of an
/// unknown game is still not a Pokémon card: the Pokémon catalog join matched it
/// on a public card id of the same number.
pub fn game_of(row: &Json) -> String {
    let raw = field_str(row, "game").trim().to_string();
    if raw.is_empty() {
        return POKEMON.to_string();
    }
    // `normalize_game` answers Pokémon for a name it does not know, so only an
    // alias of Pokémon itself may land there.
    let game = normalize_game(&raw);
    let named = game != POKEMON || is_pokemon_ingest_game(&raw.to_lowercase());
    if !named
        || game.is_empty()
        || game.len() > GAME_MAX_LEN
        || RESERVED_GAMES.contains(&game.as_str())
    {
        return UNKNOWN_GAME.to_string();
    }
    game
}

/// The longest [`set_slug`] a key can carry.
const SET_SLUG_MAX_LEN: usize = 40;

/// How many sets of one game get a line of their own. A collector of a hundred
/// sets wants the handful they actually care about, not a hundred graphs, so the
/// rest of that game's cards share its `other` segment.
pub const SETS_PER_GAME: usize = 6;

/// A set name as a key can carry it: lower case, every run of characters outside
/// `[a-z0-9]` one `-`, trimmed of `-`, at most [`SET_SLUG_MAX_LEN`] characters.
/// A name that leaves nothing behind is [`hash_slug`] of the name, and only a row
/// with **no** set name at all slugs to `unknown`. Accents are not folded into
/// letters, so `Pokémon` slugs to `pok-mon` and `拡張パック` to a hash, which is
/// why two Japanese sets never share a line.
pub fn set_slug(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return UNKNOWN_SET.to_string();
    }
    let mut slug = String::new();
    for letter in name.chars() {
        if letter.is_ascii_alphanumeric() {
            slug.push(letter.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug
        .trim_matches('-')
        .chars()
        .take(SET_SLUG_MAX_LEN)
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        hash_slug(name)
    } else {
        slug
    }
}

/// A name no ASCII letter survives in still names a set the seller holds, and
/// every one of them needs its own line: `s` plus the first 8 hex digits of the
/// FNV-1a 32 hash of its UTF-8 bytes. Stable in every process and every run, so
/// a stored key keeps meaning the set it was written for.
fn hash_slug(name: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in name.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("s{hash:08x}")
}

/// `<game>:set:<slug>` for a set name.
fn set_key(game: &str, name: &str) -> String {
    format!("{game}{SET_SEP}{}", set_slug(name))
}

/// The game and set slug of a row that belongs to a set segment: every game but
/// Pokémon, whose sets are the era bands instead.
fn set_of_row(row: &Json) -> Option<(String, String)> {
    let game = game_of(row);
    if game == POKEMON {
        return None;
    }
    Some((game, set_slug(&field_str(row, "set_name"))))
}

/// The game a set key belongs to, or `None` when the key is not one. Only keys
/// this module just built are ever inspected, never a key read back from storage.
fn set_key_game(key: &str) -> Option<&str> {
    let (game, slug) = key.split_once(SET_SEP)?;
    if game.is_empty() || slug.is_empty() || game == POKEMON {
        return None;
    }
    Some(game)
}

/// Per game how many cards of each set are held, as `<game>` → `<slug>` →
/// `<set name>` → quantity. Splitting by name is what lets a label be reported
/// for a key without keeping the rows around.
fn set_counts(rows: &[Json]) -> BTreeMap<String, BTreeMap<String, BTreeMap<String, i64>>> {
    let mut counts: BTreeMap<String, BTreeMap<String, BTreeMap<String, i64>>> = BTreeMap::new();
    for row in rows {
        let Some((game, slug)) = set_of_row(row) else {
            continue;
        };
        let name = field_str(row, "set_name").trim().to_string();
        let name = if name.is_empty() {
            UNKNOWN_SET.to_string()
        } else {
            name
        };
        *counts
            .entry(game)
            .or_default()
            .entry(slug)
            .or_default()
            .entry(name)
            .or_default() += field_i64(row, "quantity").max(0);
    }
    counts
}

/// The set keys this grouping draws its own line for: per game the
/// [`SETS_PER_GAME`] sets with the most cards held, ties in slug order. A game
/// of six sets or fewer keeps every one of them, so it has no `other` segment.
pub fn chosen_set_keys(rows: &[Json]) -> BTreeSet<String> {
    let mut chosen = BTreeSet::new();
    for (game, slugs) in set_counts(rows) {
        let mut ranked: Vec<(i64, String)> = slugs
            .into_iter()
            .map(|(slug, names)| (names.into_values().sum(), slug))
            .collect();
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        chosen.extend(
            ranked
                .into_iter()
                .take(SETS_PER_GAME)
                .map(|(_, slug)| format!("{game}{SET_SEP}{slug}")),
        );
    }
    chosen
}

/// The set names behind the set keys of these rows, as `key → label`.
/// `<game>:set:other` is absent, because its label is not a set name. Several
/// spellings that share a slug report the one the most cards are held of, ties
/// alphabetically, so the label never depends on the order the rows arrived in.
pub fn set_labels(rows: &[Json]) -> BTreeMap<String, String> {
    let chosen = chosen_set_keys(rows);
    let mut labels = BTreeMap::new();
    for (game, slugs) in set_counts(rows) {
        for (slug, names) in slugs {
            let key = format!("{game}{SET_SEP}{slug}");
            if !chosen.contains(&key) {
                continue;
            }
            let best = names
                .into_iter()
                .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
                .map(|(name, _)| name);
            if let Some(name) = best.filter(|name| name != UNKNOWN_SET) {
                labels.insert(key, name);
            }
        }
    }
    labels
}

/// The stored `segmentLabels` with this recompute's set names written over it,
/// so the set keys of older days keep their label after a game's six busiest
/// sets change. A stored value that is not a string is dropped rather than
/// echoed back into the document.
pub fn merge_segment_labels(stored: Option<&Json>, fresh: &BTreeMap<String, String>) -> Json {
    let mut merged = Map::new();
    if let Some(fields) = stored.and_then(Json::as_object) {
        for (key, value) in fields {
            if let Some(label) = value.as_str() {
                merged.insert(key.clone(), json!(label));
            }
        }
    }
    for (key, label) in fresh {
        merged.insert(key.clone(), json!(label));
    }
    Json::Object(merged)
}

/// What one game's own catalog reports about its held cards, written onto that
/// game's rows: the CardTrader blueprint id the sold book is keyed by, the set
/// name its segments are cut by, and the product type that says sealed or not.
///
/// A row the catalog does not answer for is left with **no** blueprint id, so it
/// stays held and unpriced: the Pokémon catalog join that filled that column
/// matched it on a Pokémon card of the same public id, and a wrong price is worse
/// than no price. Pokémon rows are never touched, and neither are the rows of
/// another game whose card ids collide with these — every game has its own id
/// sequence.
pub fn apply_catalog_rows(game: &str, rows: &mut [Json], catalog: &[Json]) {
    if game == POKEMON {
        return;
    }
    let mut by_card: HashMap<String, &Json> = HashMap::new();
    for row in catalog {
        let card_id = field_str(row, "card_id");
        if !card_id.is_empty() {
            by_card.insert(card_id, row);
        }
    }
    for row in rows.iter_mut() {
        if game_of(row) != game {
            continue;
        }
        let found = by_card.get(&field_str(row, "card_id")).copied();
        let Some(object) = row.as_object_mut() else {
            continue;
        };
        let write = |key: &str, fallback: &str, object: &mut Map<String, Json>| {
            let value = found.map_or_else(|| fallback.to_string(), |row| field_str(row, key));
            object.insert(key.to_string(), json!(value));
        };
        write("blueprint_id", "", object);
        write("set_name", "", object);
        write("product_type", "card", object);
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
/// graded cuts across games, and one slice inside the game — exactly one era
/// band for a Pokémon row, or the set it names for every other game.
///
/// The set key is the row's own: [`segment_holdings`] is where a set outside the
/// drawn six collapses into that game's `other` segment, because that is the
/// first place all the rows are visible.
pub fn segment_keys(row: &Json) -> Vec<String> {
    let game = game_of(row);
    let pokemon = game == POKEMON;
    let mut keys = vec![format!("{GAME_PREFIX}{game}")];
    if sealed_of(row) {
        keys.push(ALL_SEALED.to_string());
        keys.push(format!("{game}:sealed"));
    }
    if field_bool(row, &["graded"]) {
        keys.push(ALL_GRADED.to_string());
        keys.push(format!("{game}:graded"));
    }
    if pokemon {
        keys.push(format!(
            "{ERA_PREFIX}{}",
            band_of(&field_str(row, "set_code")).id
        ));
    } else {
        keys.push(set_key(&game, &field_str(row, "set_name")));
    }
    keys
}

/// Holdings rows grouped per segment key, each group in the shape the price book
/// is looked up with. A zero-quantity row drops out in `holding_slices`.
pub fn segment_holdings(rows: &[Json]) -> BTreeMap<String, Vec<Holding>> {
    let chosen = chosen_set_keys(rows);
    let mut grouped: BTreeMap<String, Vec<Json>> = BTreeMap::new();
    for row in rows {
        for key in segment_keys(row) {
            // A set the dashboard does not draw shares its game's `other` line.
            let key = match set_key_game(&key) {
                Some(game) if !chosen.contains(&key) => format!("{game}{SET_SEP}{OTHER_SET}"),
                _ => key,
            };
            grouped.entry(key).or_default().push(row.clone());
        }
    }
    grouped
        .into_iter()
        .map(|(key, rows)| (key, holding_slices(&rows)))
        .collect()
}

/// A slug read back as a name, for a set key whose stored label is gone.
fn slug_label(slug: &str) -> String {
    slug.split('-')
        .map(|word| {
            let mut letters = word.chars();
            match letters.next() {
                Some(first) => first.to_uppercase().collect::<String>() + letters.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

/// The name a set key draws under: what the recompute stored beside it, else the
/// slug read back as a name.
fn set_label(labels: Option<&Json>, key: &str, slug: &str) -> String {
    labels
        .and_then(|map| map.get(key))
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map_or_else(|| slug_label(slug), ToString::to_string)
}

/// The ordered segments the client draws, or nothing when no day carries any.
///
/// The games that appear in the days (Pokémon first, the rest by id), then the
/// sealed / graded cuts across games, then per game what slices it inside: the
/// eight era bands for Pokémon, the sets the days actually carry for every other
/// game, and then that game's own sealed and graded cuts. The bands and the
/// sealed / graded cuts are always listed, so the dashboard order never depends
/// on what happens to be held; a set line only appears once a day carries it,
/// because a set nobody holds has no key to describe.
///
/// `labels` is the stored `segmentLabels` map, `key → set name`.
pub fn segment_defs(days: &[Json], labels: Option<&Json>) -> Vec<Json> {
    let mut games: BTreeSet<&str> = BTreeSet::new();
    let mut sets: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
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
            if let Some(game) = set_key_game(key) {
                sets.entry(game).or_default().insert(key);
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
    let type_def = |game: &str, key: &str, label: &str| {
        json!({
            "key": key,
            "group": "type",
            "game": game,
            "label": label,
        })
    };
    // The collection's own game leads, whatever else is held.
    let mut ordered: Vec<&str> = Vec::new();
    if games.contains(POKEMON) {
        ordered.push(POKEMON);
    }
    ordered.extend(games.iter().copied().filter(|game| *game != POKEMON));
    let mut defs: Vec<Json> = ordered.iter().map(|game| game_def(game)).collect();
    defs.push(type_def("all", ALL_SEALED, "Sealed"));
    defs.push(type_def("all", ALL_GRADED, "Graded"));
    for game in ordered {
        if game == POKEMON {
            for band in BANDS {
                defs.push(json!({
                    "key": format!("{ERA_PREFIX}{}", band.id),
                    "group": "era",
                    "game": POKEMON,
                    "label": band.label,
                    "years": band.years,
                }));
            }
        } else {
            let other = format!("{game}{SET_SEP}{OTHER_SET}");
            let held: Vec<&str> = sets
                .get(game)
                .into_iter()
                .flat_map(|keys| keys.iter())
                .copied()
                .collect();
            let mut lines: Vec<(String, String)> = held
                .iter()
                .filter(|key| **key != other)
                .filter_map(|key| {
                    key.split_once(SET_SEP)
                        .map(|(_, slug)| (slug, (*key).to_string()))
                })
                .map(|(slug, key)| {
                    let label = if slug == UNKNOWN_SET {
                        UNKNOWN_SET_LABEL.to_string()
                    } else {
                        set_label(labels, &key, slug)
                    };
                    (label, key)
                })
                .collect();
            // Alphabetical by what the seller reads, not by the slug inside it.
            lines.sort();
            for (label, key) in lines {
                defs.push(json!({
                    "key": key,
                    "group": "set",
                    "game": game,
                    "label": label,
                }));
            }
            if held.contains(&other.as_str()) {
                defs.push(json!({
                    "key": other,
                    "group": "set",
                    "game": game,
                    "label": OTHER_SETS_LABEL,
                }));
            }
        }
        defs.push(type_def(game, &format!("{game}:sealed"), "Sealed"));
        defs.push(type_def(game, &format!("{game}:graded"), "Graded"));
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
        // A bare "M" is Mega Evolution's own code, so the catalog does place it
        // and the row lands in the post-sv band.
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
        assert_eq!(
            keys_of(&row),
            vec!["game:riftbound", "riftbound:set:unknown"]
        );
        let row = json!({
            "blueprint_id": "", "quantity": 1, "game": "riftbound", "set_name": "Outcast",
            "set_code": "sv1", "product_type": "booster_box", "graded": true
        });
        assert_eq!(
            keys_of(&row),
            vec![
                "game:riftbound",
                "all:sealed",
                "riftbound:sealed",
                "all:graded",
                "riftbound:graded",
                "riftbound:set:outcast"
            ]
        );
        // The set code is Pokémon-only: a riftbound row slices by its own set
        // name instead, whatever era that code would have landed in.
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
    fn game_of_is_the_games_own_id_in_the_platform_table() {
        for (input, expected) in [
            ("  Riftbound ", "riftbound"),
            ("one piece", "one_piece"),
            ("one-piece", "one_piece"),
            ("One Piece", "one_piece"),
            ("magic", "magic"),
            ("flesh-and-blood", "flesh_and_blood"),
            // A name of Pokémon is Pokémon, accents and abbreviations included.
            ("POKÉMON", "pokemon"),
            ("pkm", "pokemon"),
            ("default", "pokemon"),
        ] {
            assert_eq!(game_of(&json!({ "game": input })), expected, "{input:?}");
        }
        // A row that says nothing about its game is the collection's own game.
        assert_eq!(game_of(&json!({ "game": "" })), "pokemon");
        assert_eq!(game_of(&json!({})), "pokemon");
    }

    #[test]
    fn a_game_the_table_does_not_know_is_never_pokemon() {
        for input in ["a:b", "rift_bound_2", "x".repeat(60).as_str(), "!!!"] {
            assert_eq!(game_of(&json!({ "game": input })), "unknown", "{input:?}");
        }
        // An unnamed game gets no era band: it is not a Pokémon card that the
        // catalog join happened to match on its public id.
        let keys = keys_of(&json!({ "game": "rift_bound_2", "set_code": "sv1" }));
        assert_eq!(keys, vec!["game:unknown", "unknown:set:unknown"]);
    }

    #[test]
    fn a_game_never_takes_a_reserved_word_of_the_key_scheme() {
        // `all:sealed` is the cross-game cut and `game:` the game prefix, so a
        // game called either one would draw another game's line.
        for input in ["all", "game"] {
            assert_eq!(game_of(&json!({ "game": input })), "unknown", "{input:?}");
        }
        assert_eq!(
            game_of(&json!({ "game": "flesh_and_blood" })),
            "flesh_and_blood"
        );
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
        assert!(segment_defs(&[], None).is_empty());
        assert!(segment_defs(&[json!({ "date": "2026-10-08" })], None).is_empty());
        // An empty object is not a segment either.
        assert!(segment_defs(&[json!({ "date": "2026-10-08", "segments": {} })], None).is_empty());
        assert!(!segment_defs(
            &[json!({ "segments": { "game:pokemon": [1, 1, 1] } })],
            None
        )
        .is_empty());
    }

    #[test]
    fn segment_defs_lists_games_then_types_then_the_era_bands() {
        let days = vec![
            json!({ "segments": { "game:pokemon": [1, 1, 1], "game:riftbound": [2, 1, 1] } }),
            // The same game key in another day is still listed once.
            json!({ "segments": { "game:riftbound": [3, 1, 1], "pokemon:era:sv": [3, 1, 1] } }),
        ];
        let defs = segment_defs(&days, None);
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
                "riftbound:sealed",
                "riftbound:graded",
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
        // Every game gets its own sealed / graded cut, held or not, after the
        // game it belongs to is done.
        assert_eq!(
            defs[14],
            json!({ "key": "riftbound:sealed", "group": "type", "game": "riftbound", "label": "Sealed" })
        );
        assert_eq!(
            defs[15],
            json!({ "key": "riftbound:graded", "group": "type", "game": "riftbound", "label": "Graded" })
        );
    }

    #[test]
    fn segment_defs_lists_a_games_sets_before_its_own_cuts() {
        let days = vec![
            json!({
                "segments": {
                    "game:pokemon": [10, 1, 1], "pokemon:era:sv": [10, 1, 1],
                    "game:riftbound": [30, 3, 3],
                    "riftbound:set:dawn-of-a-new-era": [10, 1, 1],
                    "riftbound:set:outcast": [15, 1, 1],
                    "riftbound:set:other": [5, 1, 1],
                    "riftbound:sealed": [0, 0, 1]
                }
            }),
            // A set only another day carries is described as well.
            json!({ "segments": { "riftbound:set:plasma-storm": [4, 1, 1] } }),
        ];
        // `outcast` keeps the name the recompute stored for it; the rest fall
        // back to their slug, and `other` is always the last set line.
        let labels = json!({ "riftbound:set:outcast": "Outcast Rulebook" });
        let defs = segment_defs(&days, Some(&labels));
        let sets: Vec<(&str, &str)> = defs
            .iter()
            .filter(|def| def["group"] == json!("set"))
            .map(|def| {
                (
                    def["key"].as_str().unwrap_or_default(),
                    def["label"].as_str().unwrap_or_default(),
                )
            })
            .collect();
        assert_eq!(
            sets,
            vec![
                ("riftbound:set:dawn-of-a-new-era", "Dawn Of A New Era"),
                ("riftbound:set:outcast", "Outcast Rulebook"),
                ("riftbound:set:plasma-storm", "Plasma Storm"),
                ("riftbound:set:other", "Other sets"),
            ]
        );
        // A set line says which game it belongs to, so the client can group them.
        assert_eq!(
            defs.iter()
                .find(|def| def["key"] == json!("riftbound:set:other"))
                .unwrap(),
            &json!({
                "key": "riftbound:set:other", "group": "set", "game": "riftbound",
                "label": "Other sets"
            })
        );
        // Pokémon is untouched by the set rules: bands, then its own two cuts,
        // and only then Riftbound's sets and its own two cuts.
        let keys: Vec<&str> = defs
            .iter()
            .map(|def| def["key"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(keys[0], "game:pokemon");
        assert_eq!(keys[1], "game:riftbound");
        assert_eq!(keys[2], "all:sealed");
        assert_eq!(keys[3], "all:graded");
        assert_eq!(keys[4], "pokemon:era:vintage");
        assert_eq!(keys[12], "pokemon:sealed");
        assert_eq!(keys[13], "pokemon:graded");
        assert_eq!(keys[14], "riftbound:set:dawn-of-a-new-era");
        assert_eq!(keys[18], "riftbound:sealed");
        assert_eq!(keys[19], "riftbound:graded");
        assert_eq!(keys.len(), 20);
        // A label that was never a string is no label at all.
        let junk = json!({ "riftbound:set:outcast": json!(7) });
        let defs = segment_defs(&days, Some(&junk));
        let outcast = defs
            .iter()
            .find(|def| def["key"] == json!("riftbound:set:outcast"))
            .unwrap();
        assert_eq!(outcast["label"], json!("Outcast"));
    }

    #[test]
    fn segment_defs_sorts_the_other_games_by_id() {
        let days = vec![json!({
            "segments": { "game:riftbound": [1, 1, 1], "game:onepiece": [1, 1, 1] }
        })];
        let defs = segment_defs(&days, None);
        let games: Vec<&str> = defs
            .iter()
            .filter(|def| def["group"] == json!("game"))
            .map(|def| def["game"].as_str().unwrap_or_default())
            .collect();
        // The other games follow in id order, whether or not Pokémon is held.
        assert_eq!(games, vec!["onepiece", "riftbound"]);
    }

    /// A Riftbound single of one set, as its game's catalog rows were written
    /// onto the holdings query.
    fn held_set(name: &str, quantity: i64) -> Json {
        json!({
            "card_id": "9001", "blueprint_id": "777", "condition": "NM", "language": "EN",
            "graded": false, "quantity": quantity, "since": "2026-10-01",
            "game": "riftbound", "set_name": name, "product_type": "card"
        })
    }

    /// Seven sets of one game, held from seven cards down to one, in slug order.
    fn seven_sets() -> Vec<Json> {
        [
            "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf",
        ]
        .iter()
        .enumerate()
        .map(|(index, name)| held_set(name, 7 - index as i64))
        .collect()
    }

    #[test]
    fn a_set_name_slugs_to_what_a_key_can_carry() {
        for (name, slug) in [
            ("Dawn of a New Era", "dawn-of-a-new-era"),
            ("  Fusion   Strike  ", "fusion-strike"),
            ("151", "151"),
            ("Battle Arts: Starters", "battle-arts-starters"),
            // An accent is not a letter a key can carry, so it splits the word.
            ("Pokémon", "pok-mon"),
            ("Évolus", "volus"),
            // Nothing inside is a run of one dash, and both ends are trimmed.
            ("--evolving--skies--", "evolving-skies"),
            ("", "unknown"),
            ("   ", "unknown"),
        ] {
            assert_eq!(set_slug(name), slug, "{name:?}");
        }
        // The limit is what a key can still carry, cut without a dangling dash.
        assert_eq!(set_slug(&"x".repeat(80)), "x".repeat(40));
        assert_eq!(set_slug(&format!("{} y", "z".repeat(40))), "z".repeat(40));
        assert_eq!(
            set_key("riftbound", "Dawn of a New Era"),
            "riftbound:set:dawn-of-a-new-era"
        );
    }

    #[test]
    fn a_name_no_letter_survives_in_is_hashed_not_unknown() {
        // A name slugs to the hash exactly when no ASCII letter survives in it.
        assert_eq!(set_slug("!!!"), hash_slug("!!!"));
        assert_eq!(set_slug("拡張パック"), hash_slug("拡張パック"));
        assert_ne!(set_slug("拡張パック"), set_slug(""));
        // `s` and eight hex digits, so a hashed key is shorter than the limit.
        let slug = set_slug("拡張パック");
        assert_eq!(slug.chars().count(), 9, "{slug}");
        assert!(slug.starts_with('s'), "{slug}");
        assert!(slug[1..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    /// The published FNV-1a 32 vectors, so the hash is the algorithm and not a
    /// number this test agrees with by accident.
    #[test]
    fn the_hashed_slug_is_fnv_1a_32() {
        for (name, expected) in [
            ("a", "se40c292c"),
            ("foobar", "sbf9cf968"),
            ("!!!", "s2d53a722"),
        ] {
            assert_eq!(hash_slug(name), expected, "{name:?}");
        }
    }

    #[test]
    fn two_sets_no_ascii_letter_can_name_draw_two_lines() {
        let dawn = "拡張パック";
        let decks = "スタートデッキ";
        let rows = vec![held_set(dawn, 2), held_set(dawn, 1), held_set(decks, 4)];
        let groups = segment_holdings(&rows);
        // The same name twice is one line; two names are never one line.
        assert_eq!(
            groups[&set_key("riftbound", dawn)]
                .iter()
                .map(|h| h.qty)
                .sum::<i64>(),
            3
        );
        assert_eq!(
            groups[&set_key("riftbound", decks)]
                .iter()
                .map(|h| h.qty)
                .sum::<i64>(),
            4
        );
        assert_ne!(set_key("riftbound", dawn), set_key("riftbound", decks));
        // What the seller reads is the name, never the hash.
        let labels = set_labels(&rows);
        assert_eq!(labels[&set_key("riftbound", dawn)], dawn);
        assert_eq!(labels[&set_key("riftbound", decks)], decks);
        // And only a row with no set name at all lands in `unknown`.
        assert_eq!(set_key("riftbound", ""), "riftbound:set:unknown");
    }

    #[test]
    fn a_row_with_no_set_name_draws_under_unknown_set() {
        let rows = vec![json!({
            "card_id": "9001", "blueprint_id": "", "condition": "NM", "language": "EN",
            "graded": false, "quantity": 1, "since": "2026-10-01", "game": "riftbound",
        })];
        let days = vec![json!({ "date": "2026-10-08", "segments": {
            "game:riftbound": [0, 0, 1], "riftbound:set:unknown": [0, 0, 1],
        } })];
        let labels = merge_segment_labels(None, &set_labels(&rows));
        let defs = segment_defs(&days, Some(&labels));
        let named: Vec<&str> = defs
            .iter()
            .filter(|def| def["group"] == json!("set"))
            .map(|def| def["label"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(named, vec!["Unknown set"], "{defs:?}");
    }

    #[test]
    fn only_the_six_busiest_sets_of_a_game_get_a_line() {
        let groups = segment_holdings(&seven_sets());
        assert_eq!(
            groups["riftbound:set:alpha"]
                .iter()
                .map(|h| h.qty)
                .sum::<i64>(),
            7
        );
        // The seventh set is the smallest holding, so it shares `other`.
        assert!(!groups.contains_key("riftbound:set:golf"));
        assert_eq!(
            groups["riftbound:set:other"]
                .iter()
                .map(|h| h.qty)
                .sum::<i64>(),
            1
        );
        let chosen = chosen_set_keys(&seven_sets());
        assert_eq!(chosen.len(), SETS_PER_GAME);
        assert!(chosen.contains("riftbound:set:foxtrot"));
        // Ties are broken by slug, so which six are drawn never depends on the
        // order the rows arrived in.
        let tied: Vec<Json> = seven_sets()
            .iter()
            .map(|row| {
                let mut row = row.clone();
                row["quantity"] = json!(2);
                row
            })
            .collect();
        assert!(!chosen_set_keys(&tied).contains("riftbound:set:golf"));
        // Six sets or fewer: nothing is demoted and there is no `other` line.
        let groups = segment_holdings(&[held_set("Alpha", 1), held_set("Bravo", 1)]);
        assert!(groups.contains_key("riftbound:set:alpha"));
        assert!(!groups.contains_key("riftbound:set:other"));
        // A set nobody named is drawn as `unknown`, like a game nobody priced.
        let groups = segment_holdings(&[held_set("  ", 2)]);
        assert_eq!(
            groups["riftbound:set:unknown"]
                .iter()
                .map(|h| h.qty)
                .sum::<i64>(),
            2
        );
        // Pokémon slices its sets as era bands and never gets a set key.
        let rows = vec![single("1", "base1"), single("2", "sv1")];
        assert!(chosen_set_keys(&rows).is_empty());
        assert!(
            !segment_holdings(&rows)
                .keys()
                .any(|key| key.contains(SET_SEP)),
            "a Pokémon row grew a set key"
        );
    }

    #[test]
    fn the_set_labels_follow_the_keys_the_grouping_draws() {
        let labels = set_labels(&seven_sets());
        assert_eq!(
            labels.get("riftbound:set:alpha").map(String::as_str),
            Some("Alpha")
        );
        assert_eq!(labels.len(), SETS_PER_GAME);
        assert!(!labels.contains_key("riftbound:set:golf"));
        assert!(
            !labels.contains_key("riftbound:set:other"),
            "its label is not a set name"
        );
        // An unnamed set is a key the client labels from its slug.
        let labels = set_labels(&[held_set("  ", 1)]);
        assert!(labels.is_empty());
        assert!(chosen_set_keys(&[held_set("  ", 1)]).contains("riftbound:set:unknown"));
        // Two spellings that share a slug report the one the most cards are of.
        let labels = set_labels(&[held_set("Fusion Strike", 1), held_set("Fusion  strike", 4)]);
        assert_eq!(
            labels
                .get("riftbound:set:fusion-strike")
                .map(String::as_str),
            Some("Fusion  strike")
        );
    }

    #[test]
    fn merged_labels_keep_the_sets_that_are_no_longer_drawn() {
        let fresh = BTreeMap::from([
            ("riftbound:set:alpha".to_string(), "Alpha".to_string()),
            ("riftbound:set:bravo".to_string(), "Bravo".to_string()),
        ]);
        let stored = json!({
            "riftbound:set:alpha": "A name the catalog has since changed",
            "riftbound:set:golf": "Golf",
            "riftbound:set:echo": 7
        });
        let merged = merge_segment_labels(Some(&stored), &fresh);
        assert_eq!(
            merged["riftbound:set:alpha"],
            json!("Alpha"),
            "this recompute wins"
        );
        assert_eq!(merged["riftbound:set:bravo"], json!("Bravo"));
        assert_eq!(
            merged["riftbound:set:golf"],
            json!("Golf"),
            "a day that is already frozen still has its label"
        );
        // A stored value that is not a label is dropped, not echoed back.
        assert_eq!(merged.get("riftbound:set:echo"), None);
        // Nothing stored, and nothing fresh, are both ordinary.
        assert_eq!(
            merge_segment_labels(None, &fresh),
            json!({ "riftbound:set:alpha": "Alpha", "riftbound:set:bravo": "Bravo" })
        );
        assert_eq!(
            merge_segment_labels(Some(&stored), &Default::default()),
            json!({
                "riftbound:set:alpha": "A name the catalog has since changed",
                "riftbound:set:golf": "Golf",
            }),
            "an empty recompute keeps every stored label"
        );
    }

    /// One row per case: a Riftbound card its catalog knows, a Pokémon card of
    /// the same public id, another game's card of it, and a Riftbound card it
    /// does not know.
    fn four_rows_around_one_card_id() -> Vec<Json> {
        vec![
            held_set("A Wrong Name", 1),
            json!({ "card_id": "9001", "blueprint_id": "500", "quantity": 1, "game": "pokemon", "set_code": "sv1" }),
            json!({ "card_id": "9001", "blueprint_id": "600", "quantity": 1, "game": "one_piece" }),
            json!({
                "card_id": "9002", "blueprint_id": "700", "quantity": 1,
                "game": "riftbound", "set_name": "Lost", "product_type": "card"
            }),
        ]
    }

    #[test]
    fn a_games_catalog_answers_for_its_own_rows_only() {
        let catalog = vec![json!({
            "card_id": "9001", "blueprint_id": "777",
            "set_name": "Outcast", "product_type": "booster_box"
        })];
        let mut rows = four_rows_around_one_card_id();
        apply_catalog_rows("riftbound", &mut rows, &catalog);
        assert_eq!(rows[0]["blueprint_id"], json!("777"));
        assert_eq!(rows[0]["set_name"], json!("Outcast"));
        assert_eq!(rows[0]["product_type"], json!("booster_box"));
        // The Pokémon card of the same public id keeps the blueprint the Pokémon
        // catalog join reported, which is the one that prices it.
        assert_eq!(rows[1]["blueprint_id"], json!("500"));
        // So does another game's: every game numbers its own cards.
        assert_eq!(rows[2]["blueprint_id"], json!("600"));
        // A card this game's catalog does not answer for is left with no
        // blueprint id at all rather than a Pokémon card's.
        assert_eq!(rows[3]["blueprint_id"], json!(""));
        assert_eq!(rows[3]["set_name"], json!(""));
        assert_eq!(rows[3]["product_type"], json!("card"));
        // A lookup that failed outright is the same call with nothing in it.
        let mut gone = four_rows_around_one_card_id();
        apply_catalog_rows("riftbound", &mut gone, &[]);
        assert_eq!(gone[0]["blueprint_id"], json!(""));
        assert_eq!(gone[0]["set_name"], json!(""));
        // Asking for Pokémon is never a thing that rewrites a row.
        let mut pokemon = four_rows_around_one_card_id();
        apply_catalog_rows("pokemon", &mut pokemon, &catalog);
        assert_eq!(pokemon, four_rows_around_one_card_id());
    }

    #[test]
    fn an_unpriced_game_is_still_held_while_another_is_priced() {
        let mut rows = four_rows_around_one_card_id();
        rows.push(
            json!({ "card_id": "4242", "blueprint_id": "800", "quantity": 3, "game": "gundam" }),
        );
        apply_catalog_rows(
            "riftbound",
            &mut rows,
            &[
                json!({ "card_id": "9001", "blueprint_id": "777", "set_name": "Outcast", "product_type": "card" }),
            ],
        );
        // Gundam's database answered with nothing at all.
        apply_catalog_rows("gundam", &mut rows, &[]);
        let groups = segment_holdings(&rows);
        let riftbound: Vec<&str> = groups["game:riftbound"]
            .iter()
            .map(|holding| holding.key.as_str())
            .collect();
        assert!(
            riftbound.contains(&"777|NM|EN|-|-|-"),
            "the card its catalog confirmed: {riftbound:?}"
        );
        assert!(
            riftbound.iter().any(|key| key.starts_with("unpriced|")),
            "the card it did not is still held: {riftbound:?}"
        );
        assert_eq!(groups["game:gundam"].iter().map(|h| h.qty).sum::<i64>(), 3);
        for holding in &groups["game:gundam"] {
            assert!(
                holding.key.starts_with("unpriced|"),
                "{} is priced by a blueprint the catalog never confirmed",
                holding.key
            );
        }
        let book = HashMap::from([(
            "777|NM|EN|-|-|-".to_string(),
            vec![crate::domain::portfolio_history::PricePoint {
                day: "2026-10-01".to_string(),
                pkn: 30.0,
            }],
        )]);
        let priced = crate::domain::portfolio_history::value_holdings_on(
            &groups["game:riftbound"],
            &book,
            "2026-10-08",
        )
        .expect("two Riftbound cards are held");
        assert_eq!(
            (
                priced.cards_value_pkn,
                priced.cards_priced,
                priced.cards_held
            ),
            (30.0, 1, 2)
        );
        // FBEcho's cards are still held, so the segment reports them at zero.
        let unpriced = crate::domain::portfolio_history::value_holdings_on(
            &groups["game:gundam"],
            &book,
            "2026-10-08",
        )
        .expect("three FBEcho cards are held");
        assert_eq!(
            (
                unpriced.cards_value_pkn,
                unpriced.cards_priced,
                unpriced.cards_held
            ),
            (0.0, 0, 3)
        );
    }
}
