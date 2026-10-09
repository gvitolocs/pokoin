//! Port of `_artist_summary.js` — the `marketplace_artist_summary` rollup
//! read used by the artist index.

use serde_json::{json, Value};
use sqlx::PgPool;

use super::js;

/// `READ_SQL` — verbatim.
pub const READ_SQL: &str = "
select
  normalized_artist,
  artist,
  illustrator,
  artist_slug,
  artist_card_count,
  visible_card_count,
  profile_display_name,
  profile_image_url,
  image_url,
  cover_name,
  art_shade
from public.marketplace_artist_summary
order by artist_card_count desc, artist asc, artist_slug asc
limit $1
";

/// `readArtistSummary(query, limit)` — `None` when the table does not exist
/// yet (`42P01`), the raw rows otherwise.
pub async fn read_artist_summary(
    pool: &PgPool,
    limit: i64,
) -> Result<Option<Vec<Value>>, sqlx::Error> {
    match super::sql_json::rows_json(pool, READ_SQL, &[super::sql_json::SqlBind::Int(limit)]).await
    {
        Ok(rows) => Ok(if rows.is_empty() { None } else { Some(rows) }),
        Err(error) => {
            if is_undefined_table(&error) {
                Ok(None)
            } else {
                Err(error)
            }
        }
    }
}

fn is_undefined_table(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|db| db.code())
        .map(|code| code == "42P01")
        .unwrap_or(false)
}

/// `summaryRow(row)` — the public artist summary shape.
pub fn summary_row(row: &Value) -> Value {
    json!({
        "artist": js_or(row, "artist", "illustrator"),
        "illustrator": js_str(row, "illustrator"),
        "slug": js_str(row, "artist_slug"),
        "cardCount": number_or_zero(js::get(row, "artist_card_count")),
        "visibleCardCount": number_or_zero(js::get(row, "visible_card_count")),
        "displayName": js_or_first(row, &["profile_display_name", "artist"]),
        "profileImageUrl": js_str(row, "profile_image_url"),
        "imageUrl": js_str(row, "image_url"),
        "coverName": js_str(row, "cover_name"),
        "artShade": js_str(row, "art_shade"),
    })
}

fn js_str(row: &Value, key: &str) -> String {
    js::string_or_empty(js::get(row, key))
}

fn js_or(row: &Value, primary: &str, fallback: &str) -> String {
    let primary = js::get(row, primary);
    if js::truthy(primary) {
        return js::string_or_empty(primary);
    }
    js::string_or_empty(js::get(row, fallback))
}

fn js_or_first(row: &Value, keys: &[&str]) -> String {
    for key in keys {
        let value = js::get(row, key);
        if js::truthy(value) {
            return js::string_or_empty(value);
        }
    }
    String::new()
}

fn number_or_zero(value: Option<&Value>) -> Value {
    let n = js::number(value);
    super::js::js_json_number(if n.is_finite() { n } else { 0.0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_rows_map_to_the_public_shape() {
        let row = json!({
            "artist": "Atsuko Nishida",
            "illustrator": "Atsuko Nishida",
            "artist_slug": "atsuko-nishida",
            "artist_card_count": 1200,
            "visible_card_count": 900,
            "profile_display_name": "",
            "profile_image_url": null,
            "image_url": "https://cdn.pokoin.com/a.jpg",
            "cover_name": "Pikachu",
            "art_shade": "#123456",
        });
        let summary = summary_row(&row);
        assert_eq!(summary["artist"], json!("Atsuko Nishida"));
        assert_eq!(summary["slug"], json!("atsuko-nishida"));
        assert_eq!(summary["cardCount"], json!(1200));
        assert_eq!(summary["visibleCardCount"], json!(900));
        assert_eq!(summary["displayName"], json!("Atsuko Nishida"));
        assert_eq!(summary["profileImageUrl"], json!(""));
        assert_eq!(summary["coverName"], json!("Pikachu"));
    }

    #[test]
    fn artist_falls_back_to_illustrator() {
        let row = json!({"illustrator": "Illustrator Only"});
        let summary = summary_row(&row);
        assert_eq!(summary["artist"], json!("Illustrator Only"));
        assert_eq!(summary["cardCount"], json!(0));
    }
}
