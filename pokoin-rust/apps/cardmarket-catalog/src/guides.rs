//! The `guides` command's game registry: every game whose Cardmarket daily
//! price guide is loaded into `pokoin_marketplace.cardmarket_price_guide`
//! (migration 139, docs/PRICING.md "Price sources"). CardTrader games
//! reference Cardmarket products from their blueprint table's
//! `card_market_ids`; Cardmarket-only games from their `cardmarket_products`
//! rows. The idGame values are measured from the overlap of our
//! `card_market_ids` with each guide file.

use std::collections::HashSet;

use crate::sources::PriceGuide;

/// Where a game's catalog rows that carry `card_market_ids` live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Catalog {
    /// CardTrader-ingested game: blueprint rows in the game's own database.
    CardTrader,
    /// Cardmarket-only game: `cardmarket_products` rows.
    CardmarketOnly,
}

pub struct GuideGame {
    /// Pokoin game slug.
    pub slug: &'static str,
    /// Cardmarket idGame of the price guide file.
    pub cardmarket_game: i64,
    pub catalog: Catalog,
}

/// Registry order is the load order of `guides`.
pub const GUIDE_GAMES: &[GuideGame] = &[
    GuideGame { slug: "pokemon", cardmarket_game: 6, catalog: Catalog::CardTrader },
    GuideGame { slug: "magic", cardmarket_game: 1, catalog: Catalog::CardTrader },
    GuideGame { slug: "yugioh", cardmarket_game: 3, catalog: Catalog::CardTrader },
    GuideGame { slug: "flesh_and_blood", cardmarket_game: 16, catalog: Catalog::CardTrader },
    GuideGame { slug: "digimon", cardmarket_game: 17, catalog: Catalog::CardTrader },
    GuideGame { slug: "dragon_ball_super", cardmarket_game: 13, catalog: Catalog::CardTrader },
    GuideGame { slug: "vanguard", cardmarket_game: 8, catalog: Catalog::CardTrader },
    GuideGame { slug: "one_piece", cardmarket_game: 18, catalog: Catalog::CardTrader },
    GuideGame { slug: "lorcana", cardmarket_game: 19, catalog: Catalog::CardTrader },
    GuideGame { slug: "star_wars", cardmarket_game: 21, catalog: Catalog::CardTrader },
    GuideGame { slug: "riftbound", cardmarket_game: 22, catalog: Catalog::CardTrader },
    GuideGame { slug: "cyberpunk", cardmarket_game: 23, catalog: Catalog::CardTrader },
    GuideGame { slug: "gundam", cardmarket_game: 24, catalog: Catalog::CardTrader },
    GuideGame { slug: "sorcery", cardmarket_game: 25, catalog: Catalog::CardTrader },
    GuideGame { slug: "final_fantasy", cardmarket_game: 9, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "star_wars_destiny", cardmarket_game: 15, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "weiss_schwarz", cardmarket_game: 10, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "force_of_will", cardmarket_game: 7, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "world_of_warcraft", cardmarket_game: 2, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "battle_spirits_saga", cardmarket_game: 20, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "my_little_pony", cardmarket_game: 12, catalog: Catalog::CardmarketOnly },
    GuideGame { slug: "the_spoils", cardmarket_game: 5, catalog: Catalog::CardmarketOnly },
];

pub fn guide_game(slug: &str) -> Option<&'static GuideGame> {
    GUIDE_GAMES.iter().find(|g| g.slug == slug)
}

impl GuideGame {
    /// The database holding the game's catalog rows.
    pub fn database(&self) -> String {
        if self.slug == "pokemon" {
            "pokoin_marketplace".to_string()
        } else {
            format!("pokoin_{}", self.slug)
        }
    }

    /// The table whose `card_market_ids` reference Cardmarket products.
    pub fn catalog_table(&self) -> String {
        if self.slug == "pokemon" {
            return "public.cardtrader_pokemon_blueprints".to_string();
        }
        let table = match self.catalog {
            Catalog::CardTrader => "cardtrader_blueprints",
            Catalog::CardmarketOnly => "cardmarket_products",
        };
        format!("\"marketplace_{}\".{table}", self.slug)
    }
}

/// Fail when a guide keeps under half of a large catalog's referenced
/// products: a wrong idGame or a truncated file would otherwise pass and
/// write change-only rows for almost nothing.
pub fn sanity_check(referenced: usize, kept: usize) -> Result<(), String> {
    if referenced >= 1000 && kept * 2 < referenced {
        return Err(format!(
            "price guide keeps {kept} of {referenced} referenced products (< 50%): wrong idGame or truncated file"
        ));
    }
    Ok(())
}

/// Keep only the guide rows whose idProduct the catalog references; on a
/// duplicated idProduct the first row wins.
pub fn filter_rows<'a>(rows: &'a [PriceGuide], referenced: &HashSet<i64>) -> Vec<&'a PriceGuide> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        if !referenced.contains(&row.id) || !seen.insert(row.id) {
            continue;
        }
        out.push(row);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64) -> PriceGuide {
        PriceGuide {
            id,
            category: None,
            avg: None,
            low: None,
            trend: None,
            avg1: None,
            avg7: None,
            avg30: None,
            avg_foil: None,
            low_foil: None,
            trend_foil: None,
            avg1_foil: None,
            avg7_foil: None,
            avg30_foil: None,
        }
    }

    #[test]
    fn registry_slugs_and_id_games_are_unique() {
        let mut slugs = HashSet::new();
        let mut id_games = HashSet::new();
        for g in GUIDE_GAMES {
            assert!(slugs.insert(g.slug), "duplicate slug {}", g.slug);
            assert!(
                id_games.insert(g.cardmarket_game),
                "duplicate idGame {} ({})",
                g.cardmarket_game,
                g.slug
            );
        }
        assert_eq!(GUIDE_GAMES.len(), 22);
    }

    #[test]
    fn registry_lookups() {
        let pokemon = guide_game("pokemon").unwrap();
        assert_eq!(pokemon.cardmarket_game, 6);
        assert_eq!(pokemon.database(), "pokoin_marketplace");
        assert_eq!(pokemon.catalog_table(), "public.cardtrader_pokemon_blueprints");
        let magic = guide_game("magic").unwrap();
        assert_eq!(magic.cardmarket_game, 1);
        assert_eq!(magic.database(), "pokoin_magic");
        assert_eq!(magic.catalog_table(), "\"marketplace_magic\".cardtrader_blueprints");
        let the_spoils = guide_game("the_spoils").unwrap();
        assert_eq!(the_spoils.cardmarket_game, 5);
        assert_eq!(the_spoils.catalog_table(), "\"marketplace_the_spoils\".cardmarket_products");
        assert_eq!(guide_game("weiss_schwarz").unwrap().database(), "pokoin_weiss_schwarz");
        assert!(guide_game("pokemon_tcg").is_none());
    }

    #[test]
    fn sanity_check_thresholds() {
        // Small catalogs are never checked.
        assert!(sanity_check(0, 0).is_ok());
        assert!(sanity_check(999, 0).is_ok());
        assert!(sanity_check(2000, 999).is_err());
        assert!(sanity_check(2000, 1000).is_ok());
        assert!(sanity_check(2000, 2000).is_ok());
    }

    #[test]
    fn filter_keeps_referenced_and_dedupes_first_wins() {
        let referenced: HashSet<i64> = [1, 2, 3].into_iter().collect();
        let rows = vec![row(1), row(9), row(2), row(1), row(3), row(9)];
        let kept = filter_rows(&rows, &referenced);
        let ids: Vec<i64> = kept.iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
        assert!(filter_rows(&rows, &HashSet::new()).is_empty());
    }
}
