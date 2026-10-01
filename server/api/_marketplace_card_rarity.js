function projectedRaritySql({
  rarityColumn,
  collectorNumberSql,
  blueprintAlias = 'blueprints',
  metadataAlias = 'tcg_metadata',
}) {
  const storedRarity = `nullif(${rarityColumn}, '')`;
  const nonGenericStoredRarity = `nullif(
    case
      when lower(coalesce(${rarityColumn}, '')) <> 'card' then ${rarityColumn}
      else null
    end,
    ''
  )`;
  const collectorLabelRarity = `nullif(
    case
      when ${collectorNumberSql} like '%|%'
        and (coalesce(${rarityColumn}, '') = '' or lower(${rarityColumn}) = 'card')
      then btrim(split_part(${collectorNumberSql}, '|', 1))
      else null
    end,
    ''
  )`;
  return `coalesce(
    ${collectorLabelRarity},
    ${nonGenericStoredRarity},
    nullif(${metadataAlias}.raw_metadata#>>'{sourceCard,rarity}', ''),
    nullif(${blueprintAlias}.blueprint->>'rarity', ''),
    nullif(${blueprintAlias}.blueprint->>'collector_rarity', ''),
    nullif(${blueprintAlias}.blueprint#>>'{fixed_properties,pokemon_rarity}', ''),
    ${storedRarity},
    'Card'
  )`;
}

module.exports = {
  projectedRaritySql,
};
