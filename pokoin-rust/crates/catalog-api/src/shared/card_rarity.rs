//! Port of `_marketplace_card_rarity.js` — SQL fragment builders only.

/// `projectedRaritySql({ rarityColumn, collectorNumberSql, blueprintAlias,
/// metadataAlias })` — the projected rarity `coalesce` used by the
/// marketplace-cards/versions queries.
pub fn projected_rarity_sql(
    rarity_column: &str,
    collector_number_sql: &str,
    blueprint_alias: &str,
    metadata_alias: &str,
) -> String {
    let stored_rarity = format!("nullif({rarity_column}, '')");
    let non_generic_stored_rarity = format!(
        "nullif(
    case
      when lower(coalesce({rarity_column}, '')) <> 'card' then {rarity_column}
      else null
    end,
    ''
  )"
    );
    let collector_label_rarity = format!(
        "nullif(
    case
      when {collector_number_sql} like '%|%'
        and (coalesce({rarity_column}, '') = '' or lower({rarity_column}) = 'card')
      then btrim(split_part({collector_number_sql}, '|', 1))
      else null
    end,
    ''
  )"
    );
    format!(
        "coalesce(
    {collector_label_rarity},
    {non_generic_stored_rarity},
    nullif({metadata_alias}.raw_metadata#>>'{{sourceCard,rarity}}', ''),
    nullif({blueprint_alias}.blueprint->>'rarity', ''),
    nullif({blueprint_alias}.blueprint->>'collector_rarity', ''),
    nullif({blueprint_alias}.blueprint#>>'{{fixed_properties,pokemon_rarity}}', ''),
    {stored_rarity},
    'Card'
  )"
    )
}

/// Default-alias call, matching `projectedRaritySql({rarityColumn,
/// collectorNumberSql})`.
pub fn projected_rarity_sql_default(rarity_column: &str, collector_number_sql: &str) -> String {
    projected_rarity_sql(
        rarity_column,
        collector_number_sql,
        "blueprints",
        "tcg_metadata",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragments_nest_the_callers_columns() {
        let sql = projected_rarity_sql_default("candidates.rarity", "candidates.card_number");
        assert!(sql.contains("coalesce("));
        assert!(sql.contains("nullif(candidates.rarity, '')"));
        assert!(sql.contains("btrim(split_part(candidates.card_number, '|', 1))"));
        assert!(sql.contains("tcg_metadata.raw_metadata#>>'{sourceCard,rarity}'"));
        assert!(sql.contains("blueprints.blueprint#>>'{fixed_properties,pokemon_rarity}'"));
        assert!(sql.trim_end().ends_with("'Card'\n  )"));
    }

    #[test]
    fn aliases_are_substituted() {
        let sql = projected_rarity_sql("v.rarity", "v.n", "bp", "meta");
        assert!(sql.contains("nullif(bp.blueprint->>'rarity', '')"));
        assert!(sql.contains("meta.raw_metadata"));
    }
}
