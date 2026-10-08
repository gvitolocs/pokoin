//! Outbound marketplace redirects: public card/leftover → CardTrader, and
//! public card → TCGplayer. SQL ported verbatim from `_marketplace_leftover.js`
//! and `_tcgcsv_prices.js`.

use serde_json::{json, Value};

use crate::db::{DbPools, INGEST_GAMES};
use crate::error::{clean_text, ApiResult};

/// `cleanMarketplaceId` — 1–12 digits, the shape both public and leftover ids use.
pub fn clean_marketplace_id(value: &str) -> String {
    let text = value.trim();
    if !text.is_empty() && text.len() <= 12 && text.chars().all(|c| c.is_ascii_digit()) {
        text.to_string()
    } else {
        String::new()
    }
}

/// `cleanCardId` — any digit string (TCGplayer card ids are long).
pub fn clean_card_id(value: &str) -> String {
    let text = value.trim();
    if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) {
        text.to_string()
    } else {
        String::new()
    }
}

pub fn cardtrader_url(ct_id: &str) -> String {
    format!("https://www.cardtrader.com/en/cards/{}", ct_id)
}

pub fn tcgplayer_product_url(product_id: &str) -> String {
    let id: String = product_id.chars().filter(|c| c.is_ascii_digit()).collect();
    if id.is_empty() {
        String::new()
    } else {
        format!("https://www.tcgplayer.com/product/{id}")
    }
}

/// One `marketplace_search_candidates` hit.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogHit {
    pub card_id: String,
    pub ct_id: String,
    pub name: String,
    pub set_name: String,
    pub card_number: String,
}

/// `catalogIdsFor` SQL — unchanged from the reference.
pub const CATALOG_IDS_SQL: &str = "
      select
        card_id::text as card_id,
        ct_id::text as ct_id,
        name,
        set_name,
        card_number
      from public.marketplace_search_candidates
      where card_id = $1::bigint
         or ct_id = $1::bigint
      order by
        case when card_id = $1::bigint then 0 else 1 end,
        card_id
      limit 1
";

/// `readTcgplayerProductId` SQL — unchanged from the reference.
pub const TCGPLAYER_PRODUCT_SQL: &str = "
     SELECT product_id::text AS product_id
     FROM pokoin_product_links
     WHERE active AND game = $1 AND card_id = $2::bigint
     ORDER BY last_seen DESC NULLS LAST, product_id
     LIMIT 1
";

fn row_string(row: &Value, key: &str) -> String {
    clean_text(row.get(key).and_then(Value::as_str), 400)
}

/// Leftover/public id lookup in one game database. `None` when absent or the
/// id is not a valid marketplace id.
pub async fn catalog_ids_for(db: &DbPools, game: &str, id: &str) -> ApiResult<Option<CatalogHit>> {
    let key = clean_marketplace_id(id);
    if key.is_empty() {
        return Ok(None);
    }
    let numeric: i64 = key.parse().unwrap_or(0);
    let rows = db.query(game, CATALOG_IDS_SQL, &[json!(numeric)]).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let ct_id = row_string(row, "ct_id");
    Ok(Some(CatalogHit {
        card_id: row_string(row, "card_id"),
        ct_id: if ct_id.chars().all(|c| c.is_ascii_digit()) && !ct_id.is_empty() {
            ct_id
        } else {
            String::new()
        },
        name: row_string(row, "name"),
        set_name: row_string(row, "set_name"),
        card_number: row_string(row, "card_number"),
    }))
}

/// `catalogIdsForAnyGame` — try the requested game, then every other game DB.
/// Isolated databases that are unset simply do not answer.
pub async fn catalog_ids_for_any_game(
    db: &DbPools,
    requested_game: &str,
    id: &str,
) -> ApiResult<Option<(String, CatalogHit)>> {
    let start = crate::db::normalize_game(requested_game);
    let mut games = vec![start.clone()];
    games.extend(INGEST_GAMES.iter().map(|(game, _, _)| game.to_string()));
    games.dedup();
    for game in games {
        if let Ok(Some(hit)) = catalog_ids_for(db, &game, id).await {
            if !hit.ct_id.is_empty() {
                return Ok(Some((game, hit)));
            }
        }
    }
    Ok(None)
}

/// `readTcgplayerProductId` — best active product link for a card.
pub async fn read_tcgplayer_product_id(db: &DbPools, game: &str, card_id: &str) -> ApiResult<String> {
    let id = clean_card_id(card_id);
    if id.is_empty() {
        return Ok(String::new());
    }
    let numeric: i64 = id.parse().unwrap_or(0);
    let normalized = crate::db::normalize_game(game);
    let rows = db
        .query(
            &normalized,
            TCGPLAYER_PRODUCT_SQL,
            &[json!(normalized), json!(numeric)],
        )
        .await?;
    Ok(rows
        .first()
        .map(|row| row_string(row, "product_id"))
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_cleaning_matches_reference() {
        assert_eq!(clean_marketplace_id(" 12345 "), "12345");
        assert_eq!(clean_marketplace_id("1234567890123"), "");
        assert_eq!(clean_marketplace_id("12a"), "");
        assert_eq!(clean_marketplace_id(""), "");
        assert_eq!(clean_card_id("987654321098"), "987654321098");
        assert_eq!(clean_card_id("12.3"), "");
    }

    #[test]
    fn urls_match_reference() {
        assert_eq!(cardtrader_url("274416"), "https://www.cardtrader.com/en/cards/274416");
        assert_eq!(tcgplayer_product_url("123456"), "https://www.tcgplayer.com/product/123456");
        assert_eq!(tcgplayer_product_url("12-34"), "https://www.tcgplayer.com/product/1234");
        assert_eq!(tcgplayer_product_url("abc"), "");
    }

    #[test]
    fn catalog_hit_parsing_prefers_row_fields() {
        let row = json!({"card_id": 12, "ct_id": "34", "name": "Mew", "set_name": "Fossil", "card_number": "8/62"});
        assert_eq!(row_string(&row, "card_id"), "");
        assert_eq!(row_string(&row, "name"), "Mew");
    }
}
