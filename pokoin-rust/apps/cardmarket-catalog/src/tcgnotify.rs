//! TCGNotify's Cardmarket asks (`tcgnotify.com/api/products`).
//!
//! TCGNotify's `id` is the Cardmarket idProduct and its top-level `min_price`
//! is the cheapest current listing across languages — the same number
//! Cardmarket's own guide calls `low`. Only that field is taken: the dump's
//! `low_price`, `high_price` and both foil fields are zero on every row, and
//! it has no trend or 1/7/30-day averages, so those stay with the official
//! guide (see `overlay_tcgnotify_low` in the `external` crate).
//!
//! Names are Italian-localized even for international cards, so nothing here
//! matches on name — the id is the join.

use serde_json::Value;

/// One product's ask on the day TCGNotify last updated it.
#[derive(Clone, Debug, PartialEq)]
pub struct Ask {
    pub game: String,
    pub id_product: i64,
    /// `YYYY-MM-DD`, from the product's own `updated_at`.
    pub day: String,
    pub min_price: Option<f64>,
}

/// The Pokoin game slug of a Cardmarket product URL, or `None` for a game
/// TCGNotify tracks but Pokoin does not price.
fn game_of(link: &str) -> Option<&'static str> {
    if link.contains("/Pokemon/") {
        Some("pokemon")
    } else if link.contains("/Lorcana/") {
        Some("lorcana")
    } else if link.contains("/Riftbound/") {
        Some("riftbound")
    } else {
        None
    }
}

fn positive(value: Option<&Value>) -> Option<f64> {
    let n = value?.as_f64()?;
    (n.is_finite() && n > 0.0).then_some(n)
}

/// Parse a dump: either the bare product array or a `/api/products` page
/// (`{products: [...]}`). Products without a usable id, day or known game are
/// skipped and counted, never guessed.
pub fn parse_dump(value: &Value) -> Result<(Vec<Ask>, usize), String> {
    let products = match value {
        Value::Array(items) => items,
        Value::Object(_) => match value.get("products").and_then(Value::as_array) {
            Some(items) => items,
            None => return Err("dump has no products array".into()),
        },
        _ => return Err("dump is neither an array nor a products page".into()),
    };
    let mut asks = Vec::new();
    let mut skipped = 0usize;
    for product in products {
        let id = product
            .get("id")
            .and_then(|v| v.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| v.as_i64()));
        let day = product
            .get("updated_at")
            .and_then(Value::as_str)
            .filter(|s| s.len() >= 10)
            .map(|s| s[..10].to_string());
        let game = product.get("link").and_then(Value::as_str).and_then(game_of);
        let (Some(id_product), Some(day), Some(game)) = (id, day, game) else {
            skipped += 1;
            continue;
        };
        if chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d").is_err() {
            skipped += 1;
            continue;
        }
        asks.push(Ask {
            game: game.to_string(),
            id_product,
            day,
            min_price: positive(product.get("min_price")),
        });
    }
    Ok((asks, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn product(id: &str, link: &str, updated: &str, min: Value) -> Value {
        json!({"id": id, "link": link, "updated_at": updated, "min_price": min,
               "name": "Birichinata di Malpi (MEG 183)"})
    }

    #[test]
    fn an_italian_name_never_affects_the_join() {
        let dump = json!([product(
            "907802",
            "https://www.cardmarket.com/it/Pokemon/Products/Singles/Pikachu-m6a038",
            "2026-11-09T10:00:00",
            json!(0.3),
        )]);
        let (asks, skipped) = parse_dump(&dump).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(asks, vec![Ask {
            game: "pokemon".into(),
            id_product: 907802,
            day: "2026-11-09".into(),
            min_price: Some(0.3),
        }]);
    }

    #[test]
    fn a_products_page_is_accepted() {
        let dump = json!({"pagination": {"has_next": false, "total": null},
                          "products": [product("1", "https://www.cardmarket.com/en/Lorcana/Products/x", "2026-11-09", json!(1.5))]});
        let (asks, _) = parse_dump(&dump).unwrap();
        assert_eq!(asks[0].game, "lorcana");
    }

    #[test]
    fn riftbound_is_its_own_game() {
        let dump = json!([product("2", "https://www.cardmarket.com/en/Riftbound/Products/x", "2026-11-09", json!(2.0))]);
        let (asks, _) = parse_dump(&dump).unwrap();
        assert_eq!(asks[0].game, "riftbound");
    }

    #[test]
    fn a_delisted_product_keeps_its_row_with_no_ask() {
        let dump = json!([product("3", "https://www.cardmarket.com/en/Pokemon/Products/x", "2026-11-09", Value::Null)]);
        let (asks, skipped) = parse_dump(&dump).unwrap();
        assert_eq!(skipped, 0);
        assert_eq!(asks[0].min_price, None);
    }

    #[test]
    fn zero_and_negative_asks_are_not_prices() {
        for value in [json!(0), json!(0.0), json!(-1)] {
            let dump = json!([product("4", "https://www.cardmarket.com/en/Pokemon/Products/x", "2026-11-09", value)]);
            let (asks, _) = parse_dump(&dump).unwrap();
            assert_eq!(asks[0].min_price, None);
        }
    }

    #[test]
    fn unknown_games_and_bad_days_are_skipped_not_guessed() {
        let dump = json!([
            product("5", "https://www.cardmarket.com/en/Magic/Products/x", "2026-11-09", json!(1.0)),
            product("6", "https://www.cardmarket.com/en/Pokemon/Products/x", "not-a-day", json!(1.0)),
            product("7", "https://www.cardmarket.com/en/Pokemon/Products/x", "2026-11-09", json!(1.0)),
        ]);
        let (asks, skipped) = parse_dump(&dump).unwrap();
        assert_eq!(skipped, 2);
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].id_product, 7);
    }

    #[test]
    fn a_numeric_id_is_accepted() {
        let dump = json!([{"id": 8, "link": "https://www.cardmarket.com/en/Pokemon/Products/x",
                           "updated_at": "2026-11-09", "min_price": 1.0}]);
        let (asks, _) = parse_dump(&dump).unwrap();
        assert_eq!(asks[0].id_product, 8);
    }

    #[test]
    fn a_shapeless_dump_is_an_error() {
        assert!(parse_dump(&json!({"nope": 1})).is_err());
        assert!(parse_dump(&json!("text")).is_err());
    }
}