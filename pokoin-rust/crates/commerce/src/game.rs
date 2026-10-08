//! Marketplace game scoping, ported from `_marketplace_game.js`.
//!
//! Pokémon lives in the shared marketplace database
//! (`MARKETPLACE_DATABASE_URL` read / `MARKETPLACE_WRITER_DATABASE_URL` write).
//! Every satellite TCG has its own database selected by a per-game URL, exactly
//! like the Node `INGEST_GAMES[].databaseUrlEnv`. When a satellite URL is not
//! configured the catalog is simply not mounted in this deployment, and callers
//! report that instead of silently reading the wrong game's rows.

/// `(game id, database URL env var)` — the Node `INGEST_GAMES` env contract.
pub const SATELLITE_GAMES: [(&str, &str); 24] = [
    ("magic", "MAGIC_MARKETPLACE_DATABASE_URL"),
    ("yugioh", "YUGIOH_MARKETPLACE_DATABASE_URL"),
    ("flesh_and_blood", "FLESH_AND_BLOOD_MARKETPLACE_DATABASE_URL"),
    ("digimon", "DIGIMON_MARKETPLACE_DATABASE_URL"),
    ("dragon_ball_super", "DRAGON_BALL_SUPER_MARKETPLACE_DATABASE_URL"),
    ("vanguard", "VANGUARD_MARKETPLACE_DATABASE_URL"),
    ("one_piece", "ONE_PIECE_MARKETPLACE_DATABASE_URL"),
    ("lorcana", "LORCANA_MARKETPLACE_DATABASE_URL"),
    ("star_wars", "STAR_WARS_MARKETPLACE_DATABASE_URL"),
    ("union_arena", "UNION_ARENA_MARKETPLACE_DATABASE_URL"),
    ("riftbound", "RIFTBOUND_MARKETPLACE_DATABASE_URL"),
    ("gundam", "GUNDAM_MARKETPLACE_DATABASE_URL"),
    ("sorcery", "SORCERY_MARKETPLACE_DATABASE_URL"),
    ("palworld", "PALWORLD_MARKETPLACE_DATABASE_URL"),
    ("cyberpunk", "CYBERPUNK_MARKETPLACE_DATABASE_URL"),
    ("weiss_schwarz", "WEISS_SCHWARZ_MARKETPLACE_DATABASE_URL"),
    ("final_fantasy", "FINAL_FANTASY_MARKETPLACE_DATABASE_URL"),
    ("force_of_will", "FORCE_OF_WILL_MARKETPLACE_DATABASE_URL"),
    ("world_of_warcraft", "WORLD_OF_WARCRAFT_MARKETPLACE_DATABASE_URL"),
    ("battle_spirits_saga", "BATTLE_SPIRITS_SAGA_MARKETPLACE_DATABASE_URL"),
    ("star_wars_destiny", "STAR_WARS_DESTINY_MARKETPLACE_DATABASE_URL"),
    ("dragon_born", "DRAGON_BORN_MARKETPLACE_DATABASE_URL"),
    ("my_little_pony", "MY_LITTLE_PONY_MARKETPLACE_DATABASE_URL"),
    ("the_spoils", "THE_SPOILS_MARKETPLACE_DATABASE_URL"),
];

pub const POKEMON: &str = "pokemon";

/// The database URL env var for a game, or `None` when unknown.
pub fn game_db_env(game: &str) -> Option<&'static str> {
    if game == POKEMON {
        return Some("MARKETPLACE_DATABASE_URL");
    }
    SATELLITE_GAMES
        .iter()
        .find(|(id, _)| *id == game)
        .map(|(_, env)| *env)
}

/// The writer URL env var for a game (only the shared marketplace DB has one).
pub fn game_writer_db_env(game: &str) -> Option<&'static str> {
    if game == POKEMON {
        Some("MARKETPLACE_WRITER_DATABASE_URL")
    } else {
        None
    }
}

pub fn is_known_game(game: &str) -> bool {
    game == POKEMON || SATELLITE_GAMES.iter().any(|(id, _)| *id == game)
}

pub fn is_satellite(game: &str) -> bool {
    game != POKEMON && is_known_game(game)
}

/// A satellite catalog query that could not be served.
pub fn catalog_error(game: &str, error: impl std::fmt::Display) -> crate::error::ApiError {
    crate::error::ApiError::unavailable(format!(
        "The {game} marketplace catalog is unavailable: {error}"
    ))
    .with_code("GAME_CATALOG_UNAVAILABLE")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pokemon_maps_to_the_shared_marketplace_urls() {
        assert_eq!(game_db_env("pokemon"), Some("MARKETPLACE_DATABASE_URL"));
        assert_eq!(
            game_writer_db_env("pokemon"),
            Some("MARKETPLACE_WRITER_DATABASE_URL")
        );
    }

    #[test]
    fn satellite_games_map_to_their_own_urls() {
        assert_eq!(game_db_env("magic"), Some("MAGIC_MARKETPLACE_DATABASE_URL"));
        assert_eq!(
            game_db_env("one_piece"),
            Some("ONE_PIECE_MARKETPLACE_DATABASE_URL")
        );
        assert_eq!(
            game_db_env("flesh_and_blood"),
            Some("FLESH_AND_BLOOD_MARKETPLACE_DATABASE_URL")
        );
        assert_eq!(
            game_db_env("the_spoils"),
            Some("THE_SPOILS_MARKETPLACE_DATABASE_URL")
        );
        // Satellites have no separate writer URL: their ingest writes locally.
        assert_eq!(game_writer_db_env("magic"), None);
    }

    #[test]
    fn unknown_games_have_no_pool() {
        assert_eq!(game_db_env("chess"), None);
        assert!(!is_known_game("chess"));
        assert!(!is_satellite("chess"));
        assert!(is_satellite("magic"));
        assert!(!is_satellite("pokemon"));
    }

    #[test]
    fn catalog_errors_are_503_with_a_stable_code() {
        let error = catalog_error("magic", "connection refused");
        assert_eq!(error.status.as_u16(), 503);
        assert_eq!(error.code.as_deref(), Some("GAME_CATALOG_UNAVAILABLE"));
        assert!(error.message.contains("magic"));
        assert!(error.message.contains("connection refused"));
    }

    #[test]
    fn every_satellite_declares_a_unique_env_var() {
        let mut envs: Vec<&str> = SATELLITE_GAMES.iter().map(|(_, env)| *env).collect();
        envs.sort_unstable();
        let before = envs.len();
        envs.dedup();
        assert_eq!(envs.len(), before, "duplicate satellite env var");
        assert_eq!(SATELLITE_GAMES.len(), 24);
    }
}
