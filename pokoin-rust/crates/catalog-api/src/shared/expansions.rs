//! Port of the `marketplace-expansions.js` loaders the expansion-page BFF
//! composes: `rowsForExpansions` and `snapshotForExpansion` (plus the
//! module's `cleanLimit`/`slugify`).

use serde_json::Value;
use sqlx::PgPool;

use super::{card_emoji, js, slug};

/// `cleanLimit(value, fallback = 1000)` — clamped to 1..=2000.
pub fn clean_limit(limit: i64) -> i64 {
    if limit == 0 {
        return 1000;
    }
    limit.clamp(1, 2000)
}

/// `cleanText(value, maxLength = 180)` of this module.
pub fn clean_text(value: Option<&Value>, max_length: usize) -> String {
    js::clean_text(value, max_length)
}

/// `slugify` (identical in marketplace-expansions.js and
/// marketplace-expansion-page.js).
pub fn slugify(value: &str) -> String {
    slug::slugify(value)
}

/// `normalizedCollectorNumberSql(column)`.
pub fn normalized_collector_number_sql(column: &str) -> String {
    format!(
        "coalesce(
    substring({column} from '([A-Za-z]*[0-9]+[A-Za-z]?\\s*/\\s*[0-9]+)'),
    substring({column} from '([A-Za-z]{{1,4}}\\s*[0-9]+)'),
    {column}
  )"
    )
}

/// `normalCollectorSql(column)`.
pub fn normal_collector_sql(column: &str) -> String {
    let normalized = normalized_collector_number_sql(column);
    format!(
        "case
    when {normalized} ~ '^\\s*[0-9]+[A-Za-z]?\\s*(/[0-9]+)?\\s*$'
    then 0
    else 1
  end"
    )
}

/// `rowsForExpansions({ slug, limit })` — one representative-card row per
/// expansion, joined to the expansion wordmarks.
pub async fn rows_for_expansions(
    pool: &PgPool,
    slug: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut values: Vec<super::sql_json::SqlBind> = Vec::new();
    let mut where_clause = "where versions.expansion_name is not null and versions.expansion_name <> '' and versions.product_type = 'card'".to_string();
    let slug_value = slug.map(|s| Value::String(s.to_string()));
    let normalized_slug = clean_text(slug_value.as_ref(), 180);
    if !normalized_slug.is_empty() {
        values.push(super::sql_json::SqlBind::Text(normalized_slug));
        where_clause += &format!(
            " and {} = ${}",
            super::react_sql::expansion_slug_sql("versions.expansion_name"),
            values.len()
        );
    }
    // node-pg sent the limit untyped; sqlx binds it as bigint for `limit $n`.
    values.push(super::sql_json::SqlBind::Int(clean_limit(limit)));

    let rep_col = normalized_collector_number_sql("versions.expansion_number");
    let sql = format!(
        "
      with representative_cards as (
        select distinct on (
          versions.expansion_name,
          {rep_col}
        )
          versions.expansion_name,
          versions.expansion_number,
          versions.expansion_number_int
        from public.marketplace_card_versions versions
        {where_clause}
        order by
          versions.expansion_name asc,
          {rep_col} asc,
          versions.blueprint_id asc nulls last,
          versions.card_id asc
      )
      select
        representative_cards.expansion_name as name,
        min(expansions.symbol_image_url) as symbol_image_url,
        min(expansions.logo_image_url) as logo_image_url,
        coalesce(
          nullif(min(expansions.catalog_card_count), 0),
          nullif(min(set_counts.catalog_card_count), 0),
          0
        )::integer as card_count,
        min(expansions.nationality) as nationality
      from representative_cards
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = representative_cards.expansion_name
      left join public.marketplace_set_card_counts set_counts
        on set_counts.set_name = representative_cards.expansion_name
      group by representative_cards.expansion_name
      order by representative_cards.expansion_name asc
      limit ${}
    ",
        values.len()
    );

    let rows = super::sql_json::rows_json(pool, &sql, &values).await?;

    Ok(rows
        .iter()
        .map(|row| {
            let name = js::string_or_empty(js::get(row, "name"));
            let resolved_slug = slugify(&name);
            serde_json::json!({
                "name": name,
                "slug": resolved_slug,
                "symbolImageUrl": js::string_or_empty(js::get(row, "symbol_image_url")),
                "logoImageUrl": js::string_or_empty(js::get(row, "logo_image_url")),
                "defaultSymbolUrl": if resolved_slug.is_empty() {
                    String::new()
                } else {
                    format!("https://cdn.pokoin.com/expansions/symbols/{resolved_slug}.png")
                },
                "cardCount": js::js_json_number({
                    let n = js::number(js::get(row, "card_count"));
                    if n.is_finite() { n } else { 0.0 }
                }),
                "nationality": js::string_or_empty(js::get(row, "nationality")).trim().to_lowercase(),
            })
        })
        .collect())
}

/// `snapshotForExpansion({ slug, limit })` — `{ expansion, cards }` where the
/// cards carry the emoji fields, or `None` when the slug matches nothing.
pub async fn snapshot_for_expansion(
    pool: &PgPool,
    slug: Option<&str>,
    limit: i64,
) -> Result<Option<Value>, sqlx::Error> {
    let expansions = rows_for_expansions(pool, slug, 1).await?;
    let expansion = match expansions.into_iter().next() {
        Some(expansion) => expansion,
        None => return Ok(None),
    };
    let rep_col = normalized_collector_number_sql("representative_cards.expansion_number");
    let sql = format!(
        "
      with representative_cards as (
        select distinct on (
          versions.expansion_name,
          {rep_col}
        )
          versions.*
        from public.marketplace_card_versions versions
        where versions.expansion_name = $1
          and versions.product_type = 'card'
        order by
          versions.expansion_name asc,
          {rep_col} asc,
          versions.blueprint_id asc nulls last,
          versions.card_id asc
      )
      select
        representative_cards.card_id,
        representative_cards.name,
        representative_cards.expansion_name,
        representative_cards.expansion_number,
        representative_cards.expansion_number_int,
        representative_cards.product_variant,
        representative_cards.blueprint_id,
        representative_cards.image_url,
        representative_cards.cdn_image_url,
        representative_cards.preview_image_url,
        representative_cards.product_type,
        representative_cards.trainer_name,
        representative_cards.card_palette,
        representative_cards.emoji,
        urls.canonical_path,
        representative_cards.projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        expansions.logo_image_url as expansion_logo_url
      from representative_cards
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = representative_cards.expansion_name
      left join public.marketplace_card_urls urls
        on urls.card_id = representative_cards.card_id
        and urls.language = 'en'
      order by
        {} asc,
        representative_cards.expansion_number_int asc nulls last,
        {rep_col} asc,
        representative_cards.blueprint_id asc nulls last,
        representative_cards.card_id asc
      limit $2
    ",
        normal_collector_sql("representative_cards.expansion_number")
    );
    let binds = [
        super::sql_json::SqlBind::Text(js::string_or_empty(js::get(&expansion, "name"))),
        super::sql_json::SqlBind::Int(clean_limit(limit)),
    ];
    let cards = super::sql_json::rows_json(pool, &sql, &binds).await?;
    let cards: Vec<Value> = cards
        .iter()
        .map(card_emoji::with_card_emoji_fields)
        .collect();
    Ok(Some(
        serde_json::json!({ "expansion": expansion, "cards": cards }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_clamp_to_the_js_defaults() {
        assert_eq!(clean_limit(0), 1000);
        assert_eq!(clean_limit(5), 5);
        assert_eq!(clean_limit(9999), 2000);
        assert_eq!(clean_limit(-3), 1);
    }

    #[test]
    fn collector_number_fragments_match_the_reference() {
        let normalized = normalized_collector_number_sql("versions.expansion_number");
        assert!(normalized.contains(
            "substring(versions.expansion_number from '([A-Za-z]*[0-9]+[A-Za-z]?\\s*/\\s*[0-9]+)')"
        ));
        assert!(normalized
            .contains("substring(versions.expansion_number from '([A-Za-z]{1,4}\\s*[0-9]+)')"));
        let normal = normal_collector_sql("v.n");
        assert!(normal.contains("when coalesce("));
        assert!(normal.contains("~ '^\\s*[0-9]+[A-Za-z]?\\s*(/[0-9]+)?\\s*$'"));
    }
}
