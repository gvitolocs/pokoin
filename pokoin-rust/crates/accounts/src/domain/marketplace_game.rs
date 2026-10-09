//! Marketplace game scoping — a port of `_marketplace_game.js` plus the
//! `INGEST_GAMES` table from `_cardtrader_game_ingest.js`.
//!
//! Pokoin serves several CardTrader/Cardmarket games from one API. The game is
//! chosen per request (query, then explicit header, then host) and decides which
//! catalog database is read, whether the Pokemon joins apply, and the payload
//! limits. Node kept this in an `AsyncLocalStorage`; the Rust port threads the
//! resolved [`Game`] through explicitly, which is the same value without the
//! ambient context.

use serde_json::{json, Value as Json};

/// One catalog game, in the `INGEST_GAMES` shape (the fields this crate needs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestGame {
    pub id: &'static str,
    pub slug: &'static str,
    pub display_name: &'static str,
    pub database: &'static str,
    pub database_url_env: &'static str,
    pub hosts: &'static [&'static str],
    pub aliases: &'static [&'static str],
    /// Cardmarket-only games have no CardTrader catalog.
    pub cardmarket_only: bool,
}

/// The `INGEST_GAMES` table, verbatim.
pub const INGEST_GAMES: &[IngestGame] = &[
    IngestGame { id: "magic", slug: "magic", display_name: "Magic: the Gathering",
        database: "pokoin_magic", database_url_env: "MAGIC_MARKETPLACE_DATABASE_URL",
        hosts: &["magic.pokoin.com"], aliases: &["mtg", "magic_the_gathering"], cardmarket_only: false },
    IngestGame { id: "yugioh", slug: "yugioh", display_name: "Yu-Gi-Oh!",
        database: "pokoin_yugioh", database_url_env: "YUGIOH_MARKETPLACE_DATABASE_URL",
        hosts: &["yugioh.pokoin.com"], aliases: &["yu_gi_oh", "yu-gi-oh", "ygo"], cardmarket_only: false },
    IngestGame { id: "flesh_and_blood", slug: "flesh-and-blood", display_name: "Flesh and Blood",
        database: "pokoin_flesh_and_blood", database_url_env: "FLESH_AND_BLOOD_MARKETPLACE_DATABASE_URL",
        hosts: &["fab.pokoin.com", "fleshandblood.pokoin.com"], aliases: &["fab", "flesh-and-blood"], cardmarket_only: false },
    IngestGame { id: "digimon", slug: "digimon", display_name: "Digimon",
        database: "pokoin_digimon", database_url_env: "DIGIMON_MARKETPLACE_DATABASE_URL",
        hosts: &["digimon.pokoin.com"], aliases: &[], cardmarket_only: false },
    IngestGame { id: "dragon_ball_super", slug: "dragon-ball-super", display_name: "Dragon Ball Super",
        database: "pokoin_dragon_ball_super", database_url_env: "DRAGON_BALL_SUPER_MARKETPLACE_DATABASE_URL",
        hosts: &["dbs.pokoin.com", "dragonball.pokoin.com"], aliases: &["dbs", "dragonball", "dragon-ball-super"], cardmarket_only: false },
    IngestGame { id: "vanguard", slug: "vanguard", display_name: "Cardfight!! Vanguard",
        database: "pokoin_vanguard", database_url_env: "VANGUARD_MARKETPLACE_DATABASE_URL",
        hosts: &["vanguard.pokoin.com"], aliases: &["cardfight", "cfv"], cardmarket_only: false },
    IngestGame { id: "one_piece", slug: "one-piece", display_name: "One Piece",
        database: "pokoin_one_piece", database_url_env: "ONE_PIECE_MARKETPLACE_DATABASE_URL",
        hosts: &["onepiece.pokoin.com"], aliases: &["onepiece", "op"], cardmarket_only: false },
    IngestGame { id: "lorcana", slug: "lorcana", display_name: "Disney Lorcana",
        database: "pokoin_lorcana", database_url_env: "LORCANA_MARKETPLACE_DATABASE_URL",
        hosts: &["lorcana.pokoin.com"], aliases: &["disney_lorcana"], cardmarket_only: false },
    IngestGame { id: "star_wars", slug: "star-wars", display_name: "Star Wars Unlimited",
        database: "pokoin_star_wars", database_url_env: "STAR_WARS_MARKETPLACE_DATABASE_URL",
        hosts: &["starwars.pokoin.com"], aliases: &["swu", "starwars"], cardmarket_only: false },
    IngestGame { id: "union_arena", slug: "union-arena", display_name: "Union Arena",
        database: "pokoin_union_arena", database_url_env: "UNION_ARENA_MARKETPLACE_DATABASE_URL",
        hosts: &["unionarena.pokoin.com"], aliases: &["unionarena"], cardmarket_only: false },
    IngestGame { id: "riftbound", slug: "riftbound", display_name: "Riftbound | League of Legends",
        database: "pokoin_riftbound", database_url_env: "RIFTBOUND_MARKETPLACE_DATABASE_URL",
        hosts: &["riftbound.pokoin.com"], aliases: &["rb", "lol"], cardmarket_only: false },
    IngestGame { id: "gundam", slug: "gundam", display_name: "Gundam",
        database: "pokoin_gundam", database_url_env: "GUNDAM_MARKETPLACE_DATABASE_URL",
        hosts: &["gundam.pokoin.com"], aliases: &[], cardmarket_only: false },
    IngestGame { id: "sorcery", slug: "sorcery", display_name: "Sorcery: Contested Realm",
        database: "pokoin_sorcery", database_url_env: "SORCERY_MARKETPLACE_DATABASE_URL",
        hosts: &["sorcery.pokoin.com"], aliases: &["contested_realm"], cardmarket_only: false },
    IngestGame { id: "palworld", slug: "palworld", display_name: "Palworld",
        database: "pokoin_palworld", database_url_env: "PALWORLD_MARKETPLACE_DATABASE_URL",
        hosts: &["palworld.pokoin.com"], aliases: &[], cardmarket_only: false },
    IngestGame { id: "cyberpunk", slug: "cyberpunk", display_name: "Cyberpunk",
        database: "pokoin_cyberpunk", database_url_env: "CYBERPUNK_MARKETPLACE_DATABASE_URL",
        hosts: &["cyberpunk.pokoin.com"], aliases: &["cyberpunk_edgerunners", "edgerunners"], cardmarket_only: false },
    IngestGame { id: "weiss_schwarz", slug: "weiss-schwarz", display_name: "Weiss Schwarz",
        database: "pokoin_weiss_schwarz", database_url_env: "WEISS_SCHWARZ_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["weiss", "weissschwarz", "ws"], cardmarket_only: true },
    IngestGame { id: "final_fantasy", slug: "final-fantasy", display_name: "Final Fantasy TCG",
        database: "pokoin_final_fantasy", database_url_env: "FINAL_FANTASY_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["fftcg", "final_fantasy_tcg"], cardmarket_only: true },
    IngestGame { id: "force_of_will", slug: "force-of-will", display_name: "Force of Will",
        database: "pokoin_force_of_will", database_url_env: "FORCE_OF_WILL_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["fow"], cardmarket_only: true },
    IngestGame { id: "world_of_warcraft", slug: "world-of-warcraft", display_name: "World of Warcraft TCG",
        database: "pokoin_world_of_warcraft", database_url_env: "WORLD_OF_WARCRAFT_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["wow_tcg", "wowtcg"], cardmarket_only: true },
    IngestGame { id: "battle_spirits_saga", slug: "battle-spirits-saga", display_name: "Battle Spirits Saga",
        database: "pokoin_battle_spirits_saga", database_url_env: "BATTLE_SPIRITS_SAGA_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["battle_spirits", "bss"], cardmarket_only: true },
    IngestGame { id: "star_wars_destiny", slug: "star-wars-destiny", display_name: "Star Wars Destiny",
        database: "pokoin_star_wars_destiny", database_url_env: "STAR_WARS_DESTINY_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["swd", "destiny"], cardmarket_only: true },
    IngestGame { id: "dragon_born", slug: "dragon-born", display_name: "Dragoborne",
        database: "pokoin_dragon_born", database_url_env: "DRAGON_BORN_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["dragoborne"], cardmarket_only: true },
    IngestGame { id: "my_little_pony", slug: "my-little-pony", display_name: "My Little Pony CCG",
        database: "pokoin_my_little_pony", database_url_env: "MY_LITTLE_PONY_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["mlp", "mlp_ccg"], cardmarket_only: true },
    IngestGame { id: "the_spoils", slug: "the-spoils", display_name: "The Spoils",
        database: "pokoin_the_spoils", database_url_env: "THE_SPOILS_MARKETPLACE_DATABASE_URL",
        hosts: &[], aliases: &["spoils"], cardmarket_only: true },
];

/// `compactGameToken(value)`.
pub fn compact_game_token(value: &str) -> String {
    let lowered = value
        .trim()
        .to_ascii_lowercase()
        .replace(['\'', '\u{2019}'], "");
    let replaced: String = lowered
        .chars()
        .map(|character| {
            if character.is_ascii_lowercase() || character.is_ascii_digit() {
                character
            } else {
                '_'
            }
        })
        .collect();
    replaced.trim_matches('_').to_string()
}

fn pokemon_aliases() -> &'static [&'static str] {
    &["pokemon", "pokémon", "poke", "pkm", "pkmn", "default"]
}

/// `isPokemonIngestGame(value)`.
pub fn is_pokemon_ingest_game(value: &str) -> bool {
    let raw = value.trim().to_ascii_lowercase();
    let compact = compact_game_token(&raw);
    pokemon_aliases()
        .iter()
        .any(|alias| *alias == raw || *alias == compact)
        || compact == "pokemon"
}

/// `normalizeIngestGame(value)` — the game id, `pokemon`, or empty.
pub fn normalize_ingest_game(value: &str) -> String {
    let compact = compact_game_token(value);
    if compact.is_empty() {
        return String::new();
    }
    if is_pokemon_ingest_game(&compact) {
        return "pokemon".to_string();
    }
    let raw = value.trim().to_ascii_lowercase();
    for game in INGEST_GAMES {
        for token in [game.id, game.slug, game.display_name] {
            if compact_game_token(token) == compact {
                return game.id.to_string();
            }
        }
        for alias in game.aliases {
            if compact_game_token(alias) == compact || alias.to_ascii_lowercase() == raw {
                return game.id.to_string();
            }
        }
    }
    String::new()
}

/// `normalizeGame(value)` — the ingest id or `pokemon`, never empty.
pub fn normalize_game(value: &str) -> String {
    let ingest = normalize_ingest_game(value);
    if !ingest.is_empty() && ingest != "pokemon" {
        return ingest;
    }
    let raw = value
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_");
    if raw.is_empty() || raw == "pokemon" || raw == "poke" || raw == "default" {
        return "pokemon".to_string();
    }
    if INGEST_GAMES.iter().any(|game| game.id == raw) {
        raw
    } else {
        "pokemon".to_string()
    }
}

pub fn is_pokemon_game(game: &str) -> bool {
    normalize_game(game) == "pokemon"
}

pub fn ingest_game_config(game: &str) -> Option<&'static IngestGame> {
    let id = normalize_ingest_game(game);
    if id.is_empty() || id == "pokemon" {
        return None;
    }
    INGEST_GAMES.iter().find(|entry| entry.id == id)
}

/// `parseGameFromUrl(url)` — the query parameters only.
pub fn parse_game_from_url(game: Option<&str>, marketplace_game: Option<&str>) -> String {
    normalize_game(game.or(marketplace_game).unwrap_or(""))
}

/// `gameIdFromHost(hostname)`.
pub fn game_id_from_host(hostname: &str) -> String {
    let host = hostname
        .trim()
        .to_ascii_lowercase()
        .split(':')
        .next()
        .unwrap_or("")
        .to_string();
    if host.is_empty() {
        return "pokemon".to_string();
    }
    for game in INGEST_GAMES {
        for listed in game.hosts {
            let listed_host = listed.to_ascii_lowercase();
            if host == listed_host {
                return game.id.to_string();
            }
            let prefix = listed_host.split('.').next().unwrap_or("");
            if !prefix.is_empty() && host.starts_with(&format!("{prefix}.")) {
                return game.id.to_string();
            }
        }
    }
    "pokemon".to_string()
}

/// `firstHeaderValue(value)` — first comma element, lowercased, port stripped.
pub fn first_header_value(value: &str) -> String {
    value
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .split(':')
        .next()
        .unwrap_or("")
        .to_string()
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

/// `hostCandidatesFromRequest(req)`.
pub fn host_candidates(headers: &[(String, String)]) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    for name in ["x-pokoin-host", "x-forwarded-host", "x-original-host", "host"] {
        if let Some(value) = header(headers, name) {
            candidates.push(value.to_string());
        }
    }
    if let Some(origin) = header(headers, "origin").or_else(|| header(headers, "referer")) {
        if let Some(host) = hostname_of(origin) {
            candidates.push(host);
        }
    }
    candidates
        .iter()
        .map(|value| first_header_value(value))
        .filter(|value| !value.is_empty())
        .collect()
}

/// The hostname of an absolute URL, without the port.
pub fn hostname_of(value: &str) -> Option<String> {
    let rest = value.split("://").nth(1)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// `parseGameFromHost(req)` — the first candidate that is not Pokemon.
pub fn parse_game_from_host(headers: &[(String, String)]) -> String {
    for host in host_candidates(headers) {
        let game = game_id_from_host(&host);
        if game != "pokemon" {
            return game;
        }
    }
    "pokemon".to_string()
}

/// `parseGameFromRequest(req)` — query, then explicit header, then host.
pub fn parse_game_from_request(
    headers: &[(String, String)],
    game: Option<&str>,
    marketplace_game: Option<&str>,
) -> String {
    let from_query = parse_game_from_url(game, marketplace_game);
    if from_query != "pokemon" {
        return from_query;
    }
    if let Some(value) = header(headers, "x-pokoin-game")
        .or_else(|| header(headers, "x-marketplace-game"))
    {
        if !value.trim().is_empty() {
            return normalize_game(value);
        }
    }
    parse_game_from_host(headers)
}

/// `deriveDatabaseUrlFromMarketplace(pathname)`.
pub fn derive_database_url(base: &str, pathname: &str) -> String {
    if base.is_empty() {
        return String::new();
    }
    match url_with_pathname(base, pathname) {
        Some(url) => url,
        None => String::new(),
    }
}

/// Replace the path of `base` (a URL) with `pathname`, keeping everything else.
fn url_with_pathname(base: &str, pathname: &str) -> Option<String> {
    let scheme_end = base.find("://")?;
    let scheme = &base[..scheme_end];
    let rest = &base[scheme_end + 3..];
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        return None;
    }
    let path = if pathname.starts_with('/') {
        pathname.to_string()
    } else {
        format!("/{pathname}")
    };
    // `new URL(base); url.pathname = p` keeps the query and hash (sslmode=...).
    let tail = rest[authority_end..]
        .find(['?', '#'])
        .map(|i| &rest[authority_end + i..])
        .unwrap_or("");
    Some(format!("{scheme}://{authority}{path}{tail}"))
}

/// `databaseUrlForGame(game)` — which catalog database a request reads.
pub fn database_url_for_game(game: &str, env: &[(String, String)]) -> String {
    let lookup = |name: &str| -> String {
        env.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default()
    };
    let normalized = normalize_game(game);
    if normalized == "pokemon" {
        let primary = lookup("MARKETPLACE_DATABASE_URL");
        if !primary.is_empty() {
            return primary;
        }
        return lookup("MARKETPLACE_PEER4_DATABASE_URL");
    }
    let Some(config) = INGEST_GAMES.iter().find(|entry| entry.id == normalized) else {
        return String::new();
    };
    let explicit = lookup(config.database_url_env);
    if !explicit.is_empty() {
        return explicit;
    }
    derive_database_url(
        &lookup("MARKETPLACE_DATABASE_URL"),
        &format!("/{}", config.database),
    )
}

/// `redisCacheKey(base)` — `None` when the game is Pokemon (the default key).
pub fn redis_cache_key(base: &str, game: &str) -> String {
    let normalized = normalize_game(game);
    if normalized == "pokemon" {
        base.to_string()
    } else {
        format!("{normalized}:{base}")
    }
}

/// The public catalogue of games, for a games selector.
pub fn public_games() -> Vec<Json> {
    INGEST_GAMES
        .iter()
        .map(|game| {
            json!({
                "id": game.id,
                "slug": game.slug,
                "displayName": game.display_name,
                "database": game.database,
                "cardmarketOnly": game.cardmarket_only,
                "pokemon": false,
            })
        })
        .collect()
}

/// Read an environment variable into the `env` slice shape.
pub fn env_pairs() -> Vec<(String, String)> {
    std::env::vars().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn compact_tokens_strip_punctuation() {
        assert_eq!(compact_game_token(" One-Piece "), "one_piece");
        assert_eq!(compact_game_token("Yu-Gi-Oh!"), "yu_gi_oh");
        assert_eq!(compact_game_token("pokémon"), "pokémon".replace('é', "_"));
        assert_eq!(compact_game_token(""), "");
    }

    #[test]
    fn game_normalization_covers_ids_slugs_aliases_and_defaults() {
        for (input, expected) in [
            ("pokemon", "pokemon"),
            ("Pokémon", "pokemon"),
            ("poke", "pokemon"),
            ("default", "pokemon"),
            ("", "pokemon"),
            ("nonsense", "pokemon"),
            ("one-piece", "one_piece"),
            ("onepiece", "one_piece"),
            ("op", "one_piece"),
            ("one_piece", "one_piece"),
            ("magic", "magic"),
            ("mtg", "magic"),
            ("magic_the_gathering", "magic"),
            ("riftbound", "riftbound"),
            ("rb", "riftbound"),
            ("lol", "riftbound"),
            ("yugioh", "yugioh"),
            ("ygo", "yugioh"),
            ("fab", "flesh_and_blood"),
            ("swu", "star_wars"),
            ("weiss", "weiss_schwarz"),
            ("fftcg", "final_fantasy"),
            ("dragoborne", "dragon_born"),
            ("mlp_ccg", "my_little_pony"),
            ("spoils", "the_spoils"),
        ] {
            assert_eq!(normalize_game(input), expected, "{input}");
        }
        assert!(is_pokemon_game("pokemon"));
        assert!(is_pokemon_game("anything-unknown"));
        assert!(!is_pokemon_game("magic"));
    }

    #[test]
    fn game_configs_resolve_and_pokemon_has_none() {
        assert!(ingest_game_config("pokemon").is_none());
        assert!(ingest_game_config("").is_none());
        let magic = ingest_game_config("mtg").unwrap();
        assert_eq!(magic.id, "magic");
        assert_eq!(magic.database, "pokoin_magic");
        assert_eq!(magic.database_url_env, "MAGIC_MARKETPLACE_DATABASE_URL");
        assert!(!magic.cardmarket_only);
        assert!(ingest_game_config("fftcg").unwrap().cardmarket_only);
    }

    #[test]
    fn hosts_map_to_games_including_subdomains() {
        assert_eq!(game_id_from_host("magic.pokoin.com"), "magic");
        assert_eq!(game_id_from_host("MAGIC.POKOIN.COM:443"), "magic");
        assert_eq!(game_id_from_host("onepiece.pokoin.com"), "one_piece");
        assert_eq!(game_id_from_host("fab.pokoin.com"), "flesh_and_blood");
        assert_eq!(game_id_from_host("starwars.pokoin.com"), "star_wars");
        assert_eq!(game_id_from_host("pokoin.com"), "pokemon");
        assert_eq!(game_id_from_host(""), "pokemon");
        assert_eq!(game_id_from_host("api.pokoin.com"), "pokemon");
    }

    #[test]
    fn request_game_precedence_is_query_then_header_then_host() {
        // Query wins.
        assert_eq!(
            parse_game_from_request(
                &headers(&[("host", "magic.pokoin.com"), ("x-pokoin-game", "yugioh")]),
                Some("one-piece"),
                None
            ),
            "one_piece"
        );
        // Then the explicit header.
        assert_eq!(
            parse_game_from_request(
                &headers(&[("host", "magic.pokoin.com"), ("x-pokoin-game", "yugioh")]),
                None,
                None
            ),
            "yugioh"
        );
        // Then the marketplaceGame alias in the query.
        assert_eq!(
            parse_game_from_request(&headers(&[]), None, Some("rb")),
            "riftbound"
        );
        // Then the host, including via x-forwarded-host and origin.
        assert_eq!(
            parse_game_from_request(&headers(&[("host", "pokoin.com"), ("x-forwarded-host", "lorcana.pokoin.com")]), None, None),
            "lorcana"
        );
        assert_eq!(
            parse_game_from_request(&headers(&[("host", "pokoin.com"), ("origin", "https://gundam.pokoin.com")]), None, None),
            "gundam"
        );
        // An unknown query value leaves the host in charge.
        assert_eq!(
            parse_game_from_request(&headers(&[("host", "magic.pokoin.com")]), Some("nonsense"), None),
            "magic"
        );
        // Nothing at all is Pokemon.
        assert_eq!(parse_game_from_request(&headers(&[("host", "pokoin.com")]), None, None), "pokemon");
    }

    #[test]
    fn first_header_value_takes_the_first_comma_element() {
        assert_eq!(first_header_value(" Magic.pokoin.com , x"), "magic.pokoin.com");
        assert_eq!(first_header_value("magic.pokoin.com:443"), "magic.pokoin.com");
        assert_eq!(first_header_value(""), "");
    }

    #[test]
    fn database_urls_follow_the_game() {
        let env = vec![
            ("MARKETPLACE_DATABASE_URL".to_string(), "postgres://u:p@h:5432/pokoin".to_string()),
            ("MAGIC_MARKETPLACE_DATABASE_URL".to_string(), "postgres://u:p@h2:5432/pokoin_magic".to_string()),
        ];
        assert_eq!(
            database_url_for_game("pokemon", &env),
            "postgres://u:p@h:5432/pokoin"
        );
        // An explicit per-game URL wins.
        assert_eq!(
            database_url_for_game("magic", &env),
            "postgres://u:p@h2:5432/pokoin_magic"
        );
        // Otherwise it is derived from the base URL's host.
        assert_eq!(
            database_url_for_game("one_piece", &env),
            "postgres://u:p@h:5432/pokoin_one_piece"
        );
        // The peer-4 fallback only applies to Pokemon.
        let env = vec![("MARKETPLACE_PEER4_DATABASE_URL".to_string(), "postgres://peer/4".to_string())];
        assert_eq!(database_url_for_game("pokemon", &env), "postgres://peer/4");
        assert_eq!(database_url_for_game("magic", &env), "");
        assert_eq!(database_url_for_game("pokemon", &[]), "");
    }

    #[test]
    fn redis_keys_are_namespaced_only_for_non_pokemon() {
        assert_eq!(redis_cache_key("portfolio:x", "pokemon"), "portfolio:x");
        assert_eq!(redis_cache_key("portfolio:x", "magic"), "magic:portfolio:x");
    }

    #[test]
    fn the_public_game_list_covers_the_whole_table() {
        let games = public_games();
        assert_eq!(games.len(), INGEST_GAMES.len());
        assert_eq!(games[0]["id"], json!("magic"));
        assert_eq!(games[0]["slug"], json!("magic"));
        assert_eq!(games[0]["displayName"], json!("Magic: the Gathering"));
        let cardmarket_only = games
            .iter()
            .filter(|game| game["cardmarketOnly"] == json!(true))
            .count();
        assert_eq!(cardmarket_only, 9);
    }
}
