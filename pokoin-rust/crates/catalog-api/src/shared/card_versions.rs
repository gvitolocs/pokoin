//! Port of the `marketplace-card-versions.js` row loaders (`rowsForVersions`,
//! `candidateRowsForCardId` and their SQL builders) plus the availability
//! fragments they share with `marketplace-cards.js`
//! (`availabilityColumns`, `cardTraderAvailabilityJoin`,
//! `cheapestHomepageCacheRelationName`). The marketplace-card-versions and
//! expansion-page BFFs read through these.

use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

use super::{card_emoji, card_rarity, js, slug};

/// Heterogeneous bind value (Node's mixed `values` array).
#[derive(Debug, Clone)]
pub enum SqlParam {
    Text(String),
    Int(i64),
}

/// `cleanLimit(value, fallback = 240)` of marketplace-card-versions.js.
pub fn clean_limit(limit: i64) -> i64 {
    if limit == 0 {
        return 240;
    }
    limit.clamp(1, 1000)
}

/// `cleanText(value, maxLength = 120)` of this module.
pub fn clean_text(value: Option<&Value>, max_length: usize) -> String {
    js::clean_text(value, max_length)
}

/// `cleanProductCategory(value)` — `'graded'` or `''`.
pub fn clean_product_category(value: Option<&Value>) -> String {
    let category = clean_text(value, 60).to_lowercase();
    if category == "graded" {
        category
    } else {
        String::new()
    }
}

/// `searchTerms(value)`.
pub fn search_terms(value: &str) -> Vec<String> {
    let text = clean_text(Some(&Value::String(value.to_string())), 120).to_lowercase();
    let depluralized = plural_re().replace_all(&text, "${1}'s").into_owned();
    depluralized
        .split(|ch: char| !ch.is_ascii_lowercase() && !ch.is_ascii_digit())
        .map(str::trim)
        .filter(|term| term.chars().count() >= 2 || term.bytes().all(|b| b.is_ascii_digit()))
        .filter(|term| !term.is_empty())
        .map(str::to_string)
        .collect()
}

/// `cleanLanguage(value)`.
pub fn clean_language(value: Option<&Value>) -> String {
    let language = js::string_or_empty(value.or(Some(&Value::String("en".into()))));
    let language = language.trim().to_lowercase();
    if language_re().is_match(&language) {
        language
    } else {
        "en".to_string()
    }
}

/// `cardIdFromDoubledId(value)`.
pub fn card_id_from_doubled_id(value: Option<&Value>) -> String {
    let raw = js::string_or_empty(value).trim().to_string();
    if !raw.bytes().all(|b| b.is_ascii_digit()) || raw.is_empty() {
        return String::new();
    }
    let Ok(numeric) = raw.parse::<f64>() else {
        return String::new();
    };
    if !js::is_safe_integer(numeric) || numeric <= 0.0 || numeric as i64 % 2 != 0 {
        return String::new();
    }
    js::number_to_string(numeric / 2.0)
}

/// `pokoinOurId(value)` — the public marketplace id of a raw id.
pub fn pokoin_our_id(value: Option<&Value>) -> String {
    let raw = js::string_or_empty(value).trim().to_string();
    if !raw.bytes().all(|b| b.is_ascii_digit()) || raw.is_empty() {
        return String::new();
    }
    let Ok(numeric) = raw.parse::<f64>() else {
        return String::new();
    };
    if !js::is_safe_integer(numeric) || numeric <= 0.0 {
        return String::new();
    }
    js::number_to_string(if numeric as i64 % 2 == 1 {
        numeric * 2.0
    } else {
        numeric
    })
}

/// `resolveCardRoute({ cardId, cardSlug, doubledCardId })`.
pub fn resolve_card_route(
    card_id: &str,
    card_slug: &str,
    doubled_card_id: &str,
) -> (String, String) {
    let clean_card_slug = clean_text(Some(&Value::String(card_slug.to_string())), 240);
    let path_our_id = clean_text(Some(&Value::String(doubled_card_id.to_string())), 80);
    let clean_card_id = clean_text(Some(&Value::String(card_id.to_string())), 80);
    let id = if path_our_id.is_empty() {
        clean_card_id
    } else {
        path_our_id
    };
    (id, clean_card_slug)
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

/// `projectedExpansionNumberSql()` — the projected collector number
/// coalesce over versions, candidates, verified links, product parsing and
/// blueprint fields.
pub fn projected_expansion_number_sql() -> String {
    let clean_collector_value = |expression: &str| {
        format!(
            "nullif(
    nullif(
      nullif(regexp_replace(btrim(coalesce({expression}, '')), '^#+\\s*', ''), ''),
      versions.card_id::text
    ),
    versions.blueprint_id::text
  )"
        )
    };
    let image_collector_number = |column: &str| {
        format!(
            "replace(
    substring(coalesce({column}, '') from '([0-9]{{1,4}}[A-Za-z]?[-/][0-9]{{1,4}})'),
    '-',
    '/'
  )"
        )
    };
    format!(
        "coalesce(
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {}
  )",
        clean_collector_value("versions.expansion_number"),
        clean_collector_value("candidates.card_number"),
        clean_collector_value("verified_links.collector_number"),
        clean_collector_value("product_parsing.collector_number"),
        clean_collector_value("blueprints.blueprint#>>'{fixed_properties,collector_number}'"),
        clean_collector_value("blueprints.blueprint->>'collector_number'"),
        clean_collector_value("blueprints.blueprint->>'number'"),
        clean_collector_value("blueprints.blueprint->>'card_number'"),
        clean_collector_value("blueprints.version"),
        clean_collector_value(&image_collector_number("versions.preview_image_url")),
        clean_collector_value(&image_collector_number("versions.homepage_image_url")),
        clean_collector_value(&image_collector_number("versions.cdn_image_url")),
    )
}

/// `projectedExpansionNumberIntSql(expansionNumberSql)`.
pub fn projected_expansion_number_int_sql(expansion_number_sql: &str) -> String {
    format!("nullif(substring({expansion_number_sql} from '([0-9]+)'), '')::integer")
}

const DETAIL_CLASSIFIER_PREFIXES: [&str; 11] = [
    "card", "fixed", "common", "uncommon", "rare", "holo", "ultra", "secret", "promo", "product",
    "trading",
];

/// `cardDetailSlugParts(value)`.
pub fn card_detail_slug_parts(value: &str) -> Vec<String> {
    slug::slug_parts(value)
}

/// `normalizeCollectorNumberSlugToken(value)` — `value.replace(/^0+(?=[0-9])/, '')`:
/// strip leading zeros while at least one digit remains (`000` -> `0`).
pub fn normalize_collector_number_slug_token(value: &str) -> String {
    let stripped = value.trim_start_matches('0');
    if stripped.is_empty() {
        // All zeros (or empty): the regex keeps the final `0` via backtracking.
        if value.starts_with('0') {
            return "0".to_string();
        }
        return String::new();
    }
    stripped.to_string()
}

/// `isCollectorNumberSlugToken(value)`.
pub fn is_collector_number_slug_token(value: &str) -> bool {
    collector_token_re().is_match(value)
}

/// `collectorNumberTokenVariants(value)`.
pub fn collector_number_token_variants(value: &str) -> Vec<String> {
    if !is_collector_number_slug_token(value) {
        return Vec::new();
    }
    let normalized = normalize_collector_number_slug_token(value);
    let mut out = vec![value.to_string()];
    if normalized != value && !normalized.is_empty() {
        out.push(normalized);
    }
    out
}

/// `stripLeadingClassifierTerms(terms)`.
pub fn strip_leading_classifier_terms(terms: &[String]) -> Vec<String> {
    let mut stripped = terms.to_vec();
    while stripped.len() > 1 && DETAIL_CLASSIFIER_PREFIXES.contains(&stripped[0].as_str()) {
        stripped.remove(0);
    }
    stripped
}

/// `slugSql(column)` of this module.
pub fn slug_sql(column: &str) -> String {
    format!("trim(both '-' from regexp_replace(replace(lower(coalesce({column}, '')), 'é', 'e'), '[^a-z0-9]+', '-', 'g'))")
}

/// The versions-table `canonicalSlugForRow(row)`.
pub fn canonical_slug_for_row(row: &Value) -> String {
    let rarity = js::string_or_empty(js::get(row, "rarity"))
        .trim()
        .to_string();
    let parts = [
        if rarity.is_empty() {
            "Card".to_string()
        } else {
            rarity
        },
        js::string_or_empty(js::get(row, "name")),
        js::string_or_empty(js::get(row, "expansion_number")),
        js::string_or_empty(js::get(row, "expansion_name")),
    ];
    parts
        .iter()
        .map(|part| slug::slug_part(part))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// `canonicalPathForRow(row)`.
pub fn canonical_path_for_row(row: &Value) -> String {
    js::clean_text(
        js::get(row, "canonical_path").or_else(|| js::get(row, "canonicalPath")),
        800,
    )
}

/// `canonicalSlugMatches(left, right)`.
pub fn canonical_slug_matches(left: &str, right: &str) -> bool {
    let left_parts = strip_leading_classifier_terms(&card_detail_slug_parts(left));
    let right_parts = strip_leading_classifier_terms(&card_detail_slug_parts(right));
    if left_parts.is_empty() || right_parts.is_empty() {
        return false;
    }
    let normalize = |parts: &[String]| -> String {
        parts
            .iter()
            .map(|part| {
                if is_collector_number_slug_token(part) {
                    normalize_collector_number_slug_token(part)
                } else {
                    part.clone()
                }
            })
            .collect::<Vec<_>>()
            .join("-")
    };
    normalize(&left_parts) == normalize(&right_parts)
}

/// `collectorSlugSql(column)`.
pub fn collector_slug_sql(column: &str) -> String {
    format!("trim(both '-' from regexp_replace(regexp_replace(replace(lower(coalesce({column}, '')), 'é', 'e'), '\\y0+([0-9])', '\\1', 'g'), '[^a-z0-9]+', '-', 'g'))")
}

/// Options of `slugMatchClause`.
#[derive(Debug, Default, Clone)]
pub struct SlugMatchOptions<'a> {
    pub collector_number_sql: &'a str,
    pub ignore_leading_classifier: bool,
}

/// `slugMatchClause(slug, values, options)` — returns the SQL fragment and
/// appends the bind values in order.
pub fn slug_match_clause(
    slug: &str,
    values: &mut Vec<SqlParam>,
    options: &SlugMatchOptions<'_>,
) -> String {
    let parsed_terms = card_detail_slug_parts(slug);
    let terms = if options.ignore_leading_classifier {
        strip_leading_classifier_terms(&parsed_terms)
    } else {
        parsed_terms
    };
    if terms.is_empty() {
        return String::new();
    }
    let collector_number_sql = if options.collector_number_sql.is_empty() {
        "versions.expansion_number"
    } else {
        options.collector_number_sql
    };
    let mut clauses = Vec::new();
    for term in &terms {
        values.push(SqlParam::Text(format!("%{term}%")));
        let placeholder = values.len();
        let field_match = |field: &str| format!("{} ilike ${}", slug_sql(field), placeholder);
        let variants = collector_number_token_variants(term);
        let mut collector_placeholders = Vec::new();
        for variant in &variants {
            values.push(SqlParam::Text(format!("(^|-){variant}(-|$)")));
            collector_placeholders.push(values.len());
        }
        let collector_field_match = collector_placeholders
            .iter()
            .map(|placeholder| format!("{} ~ ${}", slug_sql(collector_number_sql), placeholder))
            .chain(collector_placeholders.iter().map(|placeholder| {
                format!(
                    "{} ~ ${}",
                    collector_slug_sql(collector_number_sql),
                    placeholder
                )
            }))
            .collect::<Vec<_>>()
            .join(" or ");
        clauses.push(format!(
            "({})",
            [
                Some(field_match("versions.name")),
                Some(field_match("versions.expansion_name")),
                Some(collector_field_match),
                Some(field_match(
                    "coalesce(candidates.rarity, versions.product_variant)"
                )),
                Some(field_match("candidates.card_type")),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n      or ")
        ));
    }
    format!(" and {}", clauses.join(" and "))
}

/// `normalCollectorSql(column)` of this module.
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

/// `searchClause(query, productType, searchLanguage, values)`.
pub fn search_clause(
    query: &str,
    product_type: &str,
    search_language: &str,
    values: &mut Vec<SqlParam>,
) -> String {
    let terms = search_terms(query);
    if terms.is_empty() {
        return String::new();
    }
    let fields: Vec<&str> = if !product_type.is_empty() {
        vec![
            "versions.name",
            "versions.expansion_name",
            "versions.product_variant",
            "versions.trainer_name",
        ]
    } else {
        vec![
            "versions.name",
            "versions.expansion_name",
            "versions.trainer_name",
            "versions.expansion_number",
        ]
    };
    let language = clean_language(Some(&Value::String(search_language.to_string())));
    let mut clauses = Vec::new();
    for term in &terms {
        values.push(SqlParam::Text(format!("%{term}%")));
        let placeholder = values.len();
        values.push(SqlParam::Text(language.clone()));
        let language_placeholder = values.len();
        let field_clauses: Vec<String> = fields
            .iter()
            .map(|field| format!("{field} ilike ${placeholder}"))
            .collect();
        // One group per term, like Node: `(fields or exists (...))`. Without the
        // outer parentheses AND binds tighter than OR, so only the first term
        // filtered and the query scanned and sorted every first-term match.
        clauses.push(format!(
            "({}
      or exists (
        select 1
        from public.marketplace_card_name_translations translations
        where translations.language = ${language_placeholder}
          and translations.name = versions.name
          and translations.localized_name ilike ${placeholder}
      ))",
            field_clauses.join(" or "),
            placeholder = placeholder,
            language_placeholder = language_placeholder,
        ));
    }
    format!(" and {}", clauses.join(" and "))
}

/// `cardTraderEligiblePredicate(alias)` (marketplace-cards.js).
pub fn card_trader_eligible_predicate(alias: &str) -> String {
    format!(
        "(
    coalesce({alias}.quantity, 0) > 0
    and public.marketplace_price_pkn_from_cardtrader({alias}.price, {alias}.price_cents, {alias}.currency) is not null
    and (
      lower(coalesce({alias}.raw_metadata->'user'->>'can_sell_via_hub', {alias}.raw_metadata->>'can_sell_via_hub', '')) in ('true', '1', 'yes', 'y')
      or lower(coalesce({alias}.raw_metadata->'user'->>'can_sell_sealed_with_ct_zero', {alias}.raw_metadata->>'can_sell_sealed_with_ct_zero', '')) in ('true', '1', 'yes', 'y')
    )
  )",
        alias = alias
    )
}

/// `availabilityColumns(prefix, cardTraderPrefix)` (marketplace-cards.js).
pub fn availability_columns(prefix: &str, card_trader_prefix: &str) -> String {
    let _ = prefix;
    let p = card_trader_prefix;
    format!(
        "
    coalesce({p}.eligible_quantity, {p}.eligible_listing_count, 0) as listed_quantity,
    {p}.cheapest_price_pkn as lowest_price_pkn,
    case
      when {p}.cheapest_price_pkn is not null
        then case
          when {p}.provider = 'pokoin_native' then 'pokoin_native_homepage_cache'
          else 'cheapest_homepage_cache_blueprint'
        end
      else null
    end as homepage_cheapest_source,
    {p}.provider as homepage_cheapest_provider,
    {p}.sample_listing_id as homepage_cheapest_listing_id,
    case
      when {p}.provider = 'cardtrader'
        then coalesce({p}.eligible_listing_count, 0)
      else 0
    end as cardtrader_eligible_listing_count,
    ({p}.provider = 'cardtrader' and coalesce({p}.eligible_listing_count, 0) > 0) as has_cardtrader_listing,
    case
      when {p}.provider = 'cardtrader'
        then coalesce({p}.eligible_quantity, 0)
      else 0
    end as cardtrader_listed_quantity,
    case
      when {p}.provider = 'cardtrader' then {p}.cheapest_price_pkn
      else null
    end as cardtrader_lowest_price_pkn,
    ({p}.provider = 'cardtrader' and coalesce({p}.eligible_listing_count, 0) > 0) as cardtrader_available
  "
    )
}

/// `cheapestHomepageCacheRelationName(query)` — cached process-wide like the
/// Node module global (errors are not cached).
pub async fn cheapest_homepage_cache_relation_name(pool: &PgPool) -> Result<String, sqlx::Error> {
    static CACHED: OnceLock<Result<String, ()>> = OnceLock::new();
    if let Some(Ok(relation)) = CACHED.get() {
        return Ok(relation.clone());
    }
    let sql = "
    select case
      when to_regclass('public.cheapest_homepage_cache_blueprint') is not null
        then 'public.cheapest_homepage_cache_blueprint'
      when to_regclass('public.cardtrader_blueprint_listing_cache') is not null
        then 'public.cardtrader_blueprint_listing_cache'
      else 'public.cheapest_homepage_cache_blueprint'
    end as relation
  ";
    let row: Option<(String,)> = sqlx::query_as(sql).fetch_optional(pool).await?;
    let relation = row
        .map(|(relation,)| relation)
        .map(clean_cheapest_homepage_cache_relation)
        .unwrap_or_else(|| "public.cheapest_homepage_cache_blueprint".to_string());
    let _ = CACHED.set(Ok(relation.clone()));
    Ok(relation)
}

/// `cleanCheapestHomepageCacheRelation(value)`.
pub fn clean_cheapest_homepage_cache_relation(value: String) -> String {
    const RELATIONS: [&str; 2] = [
        "public.cheapest_homepage_cache_blueprint",
        "public.cardtrader_blueprint_listing_cache",
    ];
    let relation = value.trim();
    if RELATIONS.contains(&relation) {
        relation.to_string()
    } else {
        "public.cheapest_homepage_cache_blueprint".to_string()
    }
}

/// `cardTraderAvailabilityJoin(candidateAlias, relation)`.
pub fn card_trader_availability_join(candidate_alias: &str, relation: &str) -> String {
    // `pokoin_card_id <> ''` is redundant for the result (card ids are never empty)
    // but lets Postgres use the partial index on pokoin_card_id for that OR arm.
    // Without it every row seq-scanned the 84k-row listing cache (~8 ms a row).
    let cache_relation = clean_cheapest_homepage_cache_relation(relation.to_string());
    let card_id_column = format!("{candidate_alias}.card_id");
    let ct_id_column = format!("{candidate_alias}.ct_id");
    format!(
        "
    left join lateral (
      select cardtrader_cache.*
      from {cache_relation} cardtrader_cache
      where cardtrader_cache.provider in ('cardtrader', 'pokoin_native')
        and cardtrader_cache.eligible_listing_count > 0
        and cardtrader_cache.cheapest_price_pkn is not null
        and (
          cardtrader_cache.blueprint_id = {ct_id_column}
          or (cardtrader_cache.pokoin_card_id = {card_id_column}::text and cardtrader_cache.pokoin_card_id <> '')
        )
      order by
        case when cardtrader_cache.blueprint_id = {ct_id_column} then 0 else 1 end,
        cardtrader_cache.cheapest_price_pkn asc,
        case when cardtrader_cache.provider = 'pokoin_native' then 0 else 1 end,
        cardtrader_cache.eligible_listing_count desc,
        cardtrader_cache.blueprint_id asc,
        cardtrader_cache.provider asc
      limit 1
    ) cardtrader on true
  "
    )
}

/// `activeNativeListingPredicate(alias)`.
pub fn active_native_listing_predicate(alias: &str) -> String {
    format!(
        "
    {alias}.status = 'active'
    and coalesce({alias}.quantity_available, 0) > 0
    and {alias}.price_pkn > 0
    and coalesce({alias}.shipping_available, true) = true
    and not (
      {alias}.nft_available = true
      and coalesce({alias}.shipping_available, false) = false
    )
  "
    )
}

/// `gradedListingSummaryJoin(candidateAlias)`.
pub fn graded_listing_summary_join(candidate_alias: &str) -> String {
    format!(
        "
    left join lateral (
      select
        count(*)::integer as active_listing_count,
        coalesce(sum(coalesce(listing.quantity_available, 0)), 0)::integer as listed_quantity,
        min(listing.price_pkn) as lowest_price_pkn,
        (array_agg(listing.id::text order by listing.price_pkn asc, listing.updated_at desc, listing.id asc))[1] as sample_listing_id,
        (array_agg(nullif(listing.grading_company, '') order by listing.price_pkn asc, listing.updated_at desc, listing.id asc))[1] as grading_company,
        (array_agg(nullif(listing.grade, '') order by listing.price_pkn asc, listing.updated_at desc, listing.id asc))[1] as grade
      from (
        select
          native_listing.*,
          case when native_listing.card_id ~ '^[0-9]+$' then native_listing.card_id::bigint else null end as card_id_bigint
        from public.marketplace_user_listings native_listing
      ) listing
      where listing.card_id_bigint = {candidate_alias}.card_id
        and listing.graded = true
        and {}
    ) graded_listings on true
  ",
        active_native_listing_predicate("listing")
    )
}

/// `gradedAvailabilityColumns(alias)`.
pub fn graded_availability_columns(alias: &str) -> String {
    format!(
        "
    coalesce({alias}.listed_quantity, 0) as listed_quantity,
    {alias}.lowest_price_pkn as lowest_price_pkn,
    case
      when coalesce({alias}.active_listing_count, 0) > 0
        then 'marketplace_user_listings_graded'
      else null
    end as homepage_cheapest_source,
    case
      when coalesce({alias}.active_listing_count, 0) > 0
        then 'pokoin_native'
      else null
    end as homepage_cheapest_provider,
    {alias}.sample_listing_id as homepage_cheapest_listing_id,
    0 as cardtrader_eligible_listing_count,
    false as has_cardtrader_listing,
    0 as cardtrader_listed_quantity,
    null::numeric as cardtrader_lowest_price_pkn,
    false as cardtrader_available,
    true as is_graded,
    {alias}.active_listing_count as graded_listing_count,
    {alias}.lowest_price_pkn as graded_lowest_price_pkn,
    {alias}.grading_company,
    {alias}.grade
  "
    )
}

/// `candidateRowsForCardId(cardId)` — the single-card fallback row.
pub async fn candidate_rows_for_card_id(
    pool: &PgPool,
    card_id: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    if card_id <= 0 {
        return Ok(Vec::new());
    }
    let cheapest_cache_relation = cheapest_homepage_cache_relation_name(pool).await?;
    let rarity_sql =
        card_rarity::projected_rarity_sql_default("candidates.rarity", "candidates.card_number");

    let sql = format!(
        "
      select
        candidates.card_id,
        candidates.name,
        candidates.set_name as expansion_name,
        candidates.card_number as expansion_number,
        nullif(substring(candidates.card_number from '([0-9]+)'), '')::integer as expansion_number_int,
        candidates.product_variant,
        coalesce(candidates.ct_id, candidates.card_id) as blueprint_id,
        candidates.image_url,
        candidates.cdn_image_url,
        candidates.preview_image_url,
        candidates.homepage_image_url,
        candidates.product_type,
        candidates.trainer_name,
        candidates.card_palette,
        candidates.emoji,
        artist.artist,
        artist.illustrator,
        {rarity_sql} as rarity,
        candidates.card_type,
        urls.canonical_path,
        candidates.imported_at as projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        {}
      from public.marketplace_search_candidates candidates
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = candidates.ct_id
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = candidates.card_id
        or tcg_metadata.blueprint_id = candidates.ct_id
      {}
      left join (
        select name, min(symbol_image_url) as symbol_image_url
        from public.pokoin_pokemon_expansions
        group by name
      ) expansions
        on expansions.name = candidates.set_name
      left join public.marketplace_blueprint_artists artist
        on artist.card_id = candidates.card_id
      left join public.marketplace_card_urls urls
        on urls.card_id = candidates.card_id
        and urls.language = 'en'
      where candidates.card_id = $1::bigint
      limit 1
    ",
        availability_columns("price_summary", "cardtrader"),
        card_trader_availability_join("candidates", &cheapest_cache_relation)
    );
    super::sql_json::rows_json(pool, &sql, &[super::sql_json::SqlBind::Int(card_id)]).await
}

/// Arguments of `rowsForVersions` (all optional filters).
#[derive(Debug, Default, Clone)]
pub struct RowsForVersionsArgs {
    pub query: String,
    pub expansion_name: String,
    pub card_id: String,
    pub card_slug: String,
    pub same_as_card_id: String,
    pub limit: i64,
    pub product_type: String,
    pub product_category: String,
    pub search_language: String,
}

/// `rowsForVersions({...})`.
pub async fn rows_for_versions(
    pool: &PgPool,
    args: &RowsForVersionsArgs,
) -> Result<Vec<Value>, sqlx::Error> {
    let (route_card_id, route_card_slug) = resolve_card_route(&args.card_id, &args.card_slug, "");
    let mut values: Vec<SqlParam> = Vec::new();
    let expansion_number_sql = projected_expansion_number_sql();
    let expansion_number_int_sql = projected_expansion_number_int_sql(&expansion_number_sql);
    let rarity_sql =
        card_rarity::projected_rarity_sql_default("candidates.rarity", &expansion_number_sql);
    let mut where_clause =
        "where coalesce(versions.preview_image_url, versions.cdn_image_url, versions.image_url) is not null"
            .to_string();

    let normalized_card_id = js::number(Some(&Value::String(route_card_id.clone())));
    if js::is_safe_integer(normalized_card_id) && normalized_card_id > 0.0 {
        let id = normalized_card_id as i64;
        values.push(SqlParam::Int(id));
        where_clause += &format!(
            " and versions.card_id = coalesce((
      select resolved.card_id
      from (
        select c.card_id
        from public.marketplace_search_candidates c
        where c.card_id = ${}::bigint
        union all
        select c.card_id
        from public.marketplace_search_candidates c
        where c.ct_id = ${}::bigint
      ) resolved
      limit 1
    ), ${}::bigint)",
            values.len(),
            values.len(),
            values.len()
        );
    }
    where_clause += &slug_match_clause(
        &route_card_slug,
        &mut values,
        &SlugMatchOptions {
            collector_number_sql: &expansion_number_sql,
            ignore_leading_classifier: true,
        },
    );

    let normalized_same_as = js::number(Some(&Value::String(args.same_as_card_id.clone())));
    if js::is_safe_integer(normalized_same_as) && normalized_same_as > 0.0 {
        let id = normalized_same_as as i64;
        values.push(SqlParam::Int(id));
        where_clause += &format!(
            " and exists (
      select 1
      from public.marketplace_card_versions target
      where target.card_id = ${}
        and target.name = versions.name
        and target.expansion_name = versions.expansion_name
    )",
            values.len()
        );
    }

    let normalized_expansion = clean_text(Some(&Value::String(args.expansion_name.clone())), 120);
    if !normalized_expansion.is_empty() {
        values.push(SqlParam::Text(normalized_expansion.clone()));
        where_clause += &format!(" and versions.expansion_name = ${}", values.len());
    }

    let normalized_product_type = clean_text(Some(&Value::String(args.product_type.clone())), 60);
    let normalized_product_category =
        clean_product_category(Some(&Value::String(args.product_category.clone())));
    let graded_only = normalized_product_category == "graded";
    if !normalized_product_type.is_empty() {
        values.push(SqlParam::Text(normalized_product_type.clone()));
        where_clause += &format!(" and versions.product_type = ${}", values.len());
    }

    where_clause += &search_clause(
        &args.query,
        &normalized_product_type,
        &args.search_language,
        &mut values,
    );
    if graded_only {
        where_clause += " and coalesce(graded_listings.active_listing_count, 0) > 0";
    }
    values.push(SqlParam::Int(clean_limit(args.limit)));
    let cheapest_cache_relation = if graded_only {
        String::new()
    } else {
        cheapest_homepage_cache_relation_name(pool).await?
    };
    let availability_sql = if graded_only {
        graded_availability_columns("graded_listings")
    } else {
        availability_columns("price_summary", "cardtrader")
    };
    let availability_join_sql = if graded_only {
        graded_listing_summary_join("versions")
    } else {
        card_trader_availability_join("versions", &cheapest_cache_relation)
    };

    let sql = format!(
        "
      select
        versions.card_id,
        versions.name,
        versions.expansion_name,
        {expansion_number_sql} as expansion_number,
        {expansion_number_int_sql} as expansion_number_int,
        versions.product_variant,
        versions.blueprint_id,
        versions.image_url,
        versions.cdn_image_url,
        versions.preview_image_url,
        versions.homepage_image_url,
        versions.product_type,
        versions.trainer_name,
        versions.card_palette,
        versions.emoji,
        artist.artist,
        artist.illustrator,
        {rarity_sql} as rarity,
        candidates.card_type,
        urls.canonical_path,
        versions.projected_at,
        expansions.symbol_image_url as expansion_symbol_url,
        {availability_sql}
      from public.marketplace_card_versions versions
      left join public.marketplace_search_candidates candidates
        on candidates.card_id = versions.card_id
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = versions.ct_id
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = versions.card_id
        or tcg_metadata.blueprint_id = versions.ct_id
      {availability_join_sql}
      left join lateral (
        select collector_number
        from public.marketplace_cm_verified_links link
        where link.blueprint_id = versions.ct_id
          and nullif(link.collector_number, '') is not null
        order by
          case link.confidence when 'verified' then 0 when 'manual' then 1 else 2 end,
          link.verified_at desc nulls last,
          link.updated_at desc nulls last
        limit 1
      ) verified_links on true
      left join lateral (
        select collector_number
        from public.marketplace_cm_product_parsing parsing
        where parsing.blueprint_id = versions.ct_id
          and nullif(parsing.collector_number, '') is not null
        order by parsing.verified_at desc nulls last, parsing.updated_at desc nulls last
        limit 1
      ) product_parsing on true
      left join (
        select name, min(symbol_image_url) as symbol_image_url
        from public.pokoin_pokemon_expansions
        group by name
      ) expansions
        on expansions.name = versions.expansion_name
      left join public.marketplace_blueprint_artists artist
        on artist.card_id = versions.card_id
      left join public.marketplace_card_urls urls
        on urls.card_id = versions.card_id
        and urls.language = 'en'
      {where_clause}
      order by
        versions.expansion_name asc,
        {} asc,
        {expansion_number_int_sql} asc nulls last,
        {} asc,
        versions.blueprint_id asc nulls last,
        versions.card_id asc
      limit ${}
    ",
        normal_collector_sql(&expansion_number_sql),
        normalized_collector_number_sql(&expansion_number_sql),
        values.len()
    );

    let binds: Vec<super::sql_json::SqlBind> = values
        .iter()
        .map(|value| match value {
            SqlParam::Text(text) => super::sql_json::SqlBind::Text(text.clone()),
            SqlParam::Int(n) => super::sql_json::SqlBind::Int(*n),
        })
        .collect();
    let rows = super::sql_json::rows_json(pool, &sql, &binds).await?;

    let filtered_by_route = !rows.is_empty()
        || !args.query.is_empty()
        || !normalized_expansion.is_empty()
        || !args.same_as_card_id.is_empty()
        || !normalized_product_type.is_empty()
        || !normalized_product_category.is_empty();
    if filtered_by_route {
        return Ok(rows
            .iter()
            .map(card_emoji::with_card_emoji_fields)
            .collect());
    }

    let fallback_rows = candidate_rows_for_card_id(
        pool,
        if js::is_safe_integer(normalized_card_id) {
            normalized_card_id as i64
        } else {
            0
        },
    )
    .await?;
    if route_card_slug.is_empty() {
        return Ok(fallback_rows
            .iter()
            .map(card_emoji::with_card_emoji_fields)
            .collect());
    }
    Ok(fallback_rows
        .iter()
        .filter(|row| {
            let canonical_path = canonical_path_for_row(row);
            let canonical_slug = if !canonical_path.is_empty() {
                canonical_path
                    .split('/')
                    .filter(|part| !part.is_empty())
                    .skip(4)
                    .collect::<Vec<_>>()
                    .join("-")
            } else {
                canonical_slug_for_row(row)
            };
            canonical_slug_matches(&canonical_slug, &route_card_slug)
        })
        .map(card_emoji::with_card_emoji_fields)
        .collect())
}

fn plural_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\b([a-z0-9]+)s\b").expect("valid regex"))
}

fn language_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[a-z]{2}(?:-[a-z]{2})?$").expect("valid regex"))
}

fn collector_token_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^[0-9]+[a-z]?$").expect("valid regex"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn limits_and_categories() {
        assert_eq!(clean_limit(0), 240);
        assert_eq!(clean_limit(5), 5);
        assert_eq!(clean_limit(9999), 1000);
        assert_eq!(clean_limit(-1), 1);
        assert_eq!(clean_product_category(Some(&json!("GRADED"))), "graded");
        assert_eq!(clean_product_category(Some(&json!("sealed"))), "");
        assert_eq!(clean_product_category(None), "");
    }

    #[test]
    fn search_terms_depluralize_and_keep_numbers() {
        assert_eq!(
            search_terms("Charizard cards"),
            vec!["charizard".to_string(), "card".to_string()]
        );
        assert_eq!(
            search_terms("pikachu 025"),
            vec!["pikachu".to_string(), "025".to_string()]
        );
        assert_eq!(search_terms("a"), Vec::<String>::new());
        assert_eq!(search_terms(""), Vec::<String>::new());
        assert_eq!(search_terms("  vMAX!!  "), vec!["vmax".to_string()]);
    }

    #[test]
    fn languages_default_to_en() {
        assert_eq!(clean_language(None), "en");
        assert_eq!(clean_language(Some(&json!("JA"))), "ja");
        assert_eq!(clean_language(Some(&json!("pt-br"))), "pt-br");
        assert_eq!(clean_language(Some(&json!("xx"))), "xx");
        assert_eq!(clean_language(Some(&json!("toolong"))), "en");
        assert_eq!(clean_language(Some(&json!("x"))), "en");
    }

    #[test]
    fn doubled_ids_and_our_ids() {
        assert_eq!(card_id_from_doubled_id(Some(&json!("668126"))), "334063");
        assert_eq!(card_id_from_doubled_id(Some(&json!("668125"))), "");
        assert_eq!(card_id_from_doubled_id(Some(&json!("abc"))), "");
        assert_eq!(pokoin_our_id(Some(&json!("334063"))), "668126");
        assert_eq!(pokoin_our_id(Some(&json!("668126"))), "668126");
        assert_eq!(pokoin_our_id(Some(&json!("0"))), "");
    }

    #[test]
    fn routes_prefer_doubled_ids() {
        assert_eq!(
            resolve_card_route("5", " slug ", "10"),
            ("10".to_string(), "slug".to_string())
        );
        assert_eq!(
            resolve_card_route("5", "slug", ""),
            ("5".to_string(), "slug".to_string())
        );
    }

    #[test]
    fn collector_tokens_normalize() {
        assert!(is_collector_number_slug_token("025"));
        assert!(!is_collector_number_slug_token("25x3"));
        assert_eq!(collector_number_token_variants("025"), vec!["025", "25"]);
        assert_eq!(collector_number_token_variants("25"), vec!["25"]);
        assert_eq!(
            collector_number_token_variants("charizard"),
            Vec::<String>::new()
        );
        assert_eq!(normalize_collector_number_slug_token("000"), "0");
        assert_eq!(normalize_collector_number_slug_token("0"), "0");
        assert_eq!(normalize_collector_number_slug_token("007"), "7");
    }

    #[test]
    fn classifier_prefixes_strip_but_keep_the_last_term() {
        let terms = vec!["card".to_string(), "pikachu".to_string()];
        assert_eq!(strip_leading_classifier_terms(&terms), vec!["pikachu"]);
        assert_eq!(
            strip_leading_classifier_terms(&["card".to_string()]),
            vec!["card"]
        );
        assert_eq!(
            strip_leading_classifier_terms(&["charizard".to_string(), "gx".to_string()]),
            vec!["charizard", "gx"]
        );
    }

    #[test]
    fn slug_clauses_bind_every_term() {
        let mut values = Vec::new();
        let clause = slug_match_clause(
            "card-charizard-4-102",
            &mut values,
            &SlugMatchOptions {
                collector_number_sql: "versions.expansion_number",
                ignore_leading_classifier: true,
            },
        );
        assert!(clause.starts_with(" and ("));
        // slugSql(field) ilike $n — the field is wrapped in the slug SQL.
        assert!(clause.contains("ilike $1"));
        assert!(clause.contains("coalesce(candidates.rarity, versions.product_variant)"));
        assert!(clause.contains("candidates.card_type"));
        assert!(clause.contains("'(^|-)4(-|$)'") == false); // placeholders are $n binds
        assert!(clause.contains('~'));
        // charizard + "4" (4, and 4-normalized duplicates dedupe to one) + "102".
        // charizard(1) + 4: value+variant(2) + 102: value+variant(2).
        assert_eq!(values.len(), 5);
        assert!(matches!(values[0], SqlParam::Text(ref t) if t == "%charizard%"));

        let mut empty = Vec::new();
        assert_eq!(
            slug_match_clause("!!", &mut empty, &SlugMatchOptions::default()),
            ""
        );
        assert!(empty.is_empty());
    }

    #[test]
    fn canonical_slugs_match_after_normalization() {
        assert!(canonical_slug_matches(
            "card-pikachu-4-102-base-set",
            "pikachu-04-102-base-set"
        ));
        assert!(canonical_slug_matches(
            "pikachu-4-102-base-set",
            "pikachu-4-102-base-set"
        ));
        assert!(!canonical_slug_matches(
            "card-pikachu-4-102",
            "charizard-4-102"
        ));
        assert!(!canonical_slug_matches("", "pikachu"));
        assert_eq!(
            canonical_slug_for_row(&json!({
                "rarity": "Rare",
                "name": "Charizard",
                "expansion_number": "4/102",
                "expansion_name": "Base Set",
            })),
            "rare-charizard-4-102-base-set"
        );
        assert_eq!(
            canonical_path_for_row(&json!({"canonical_path": " /marketplace/en/cards/5/x "})),
            "/marketplace/en/cards/5/x"
        );
    }

    #[test]
    fn search_clauses_bind_terms_and_language() {
        let mut values = Vec::new();
        let clause = search_clause("Pikachu", "card", "ja", &mut values);
        assert!(clause.contains("versions.name ilike $1"));
        assert!(clause.contains("translations.language = $2"));
        assert!(clause.contains("translations.localized_name ilike $1"));
        assert!(matches!(values[1], SqlParam::Text(ref t) if t == "ja"));
        // Every term is its own group, so a later term still filters.
        let mut two = Vec::new();
        let grouped = search_clause("pikachu ex", "card", "en", &mut two);
        assert!(grouped.starts_with(" and (versions.name ilike $1 or"), "{grouped}");
        assert!(grouped.contains("ilike $1
      )) and (versions.name ilike $3 or"), "{grouped}");
        assert!(grouped.ends_with("ilike $3
      ))"), "{grouped}");
        assert_eq!(grouped.matches('(').count(), grouped.matches(')').count());
        let mut none = Vec::new();
        assert_eq!(search_clause("", "", "en", &mut none), "");
        assert!(none.is_empty());
        // productType empty changes the field set.
        let mut values2 = Vec::new();
        let clause2 = search_clause("mew", "", "en", &mut values2);
        assert!(clause2.contains("versions.expansion_number ilike $1"));
        assert!(!clause2.contains("product_variant"));
    }

    #[test]
    fn availability_fragments_use_the_prefixes() {
        let columns = availability_columns("price_summary", "cardtrader");
        assert!(columns.contains("coalesce(cardtrader.eligible_quantity, cardtrader.eligible_listing_count, 0) as listed_quantity"));
        assert!(columns.contains("cheapest_homepage_cache_blueprint"));
        assert!(columns.contains("pokoin_native_homepage_cache"));
        let graded = graded_availability_columns("graded_listings");
        assert!(graded.contains("'marketplace_user_listings_graded'"));
        assert!(graded.contains("true as is_graded"));
        let join = card_trader_availability_join("c", "public.cheapest_homepage_cache_blueprint");
        assert!(join.contains("cardtrader_cache.blueprint_id = c.ct_id"));
        assert!(join.contains("(cardtrader_cache.pokoin_card_id = c.card_id::text and cardtrader_cache.pokoin_card_id <> '')"));
        assert!(card_trader_availability_join("v", "bogus")
            .contains("public.cheapest_homepage_cache_blueprint"));
        assert!(
            card_trader_availability_join("v", "public.cardtrader_blueprint_listing_cache")
                .contains("cardtrader_blueprint_listing_cache")
        );
        assert!(graded_listing_summary_join("versions").contains("listing.graded = true"));
        assert!(active_native_listing_predicate("listing").contains("listing.status = 'active'"));
    }

    #[test]
    fn projected_numbers_nest_the_twelve_sources() {
        let sql = projected_expansion_number_sql();
        assert_eq!(sql.matches("nullif(").count() >= 24, true);
        assert!(sql.contains("blueprints.blueprint#>>'{fixed_properties,collector_number}'"));
        assert!(sql.contains("replace("));
        let int_sql = projected_expansion_number_int_sql(&sql);
        assert!(int_sql.starts_with("nullif(substring(coalesce("));
        assert!(int_sql.ends_with("from '([0-9]+)'), '')::integer"));
    }

    #[test]
    fn every_slug_helper_output_is_valid_fragment_shape() {
        assert!(slug_sql("versions.name")
            .contains("regexp_replace(replace(lower(coalesce(versions.name, '')), 'é', 'e')"));
        assert!(collector_slug_sql("v.n").contains("\\y0+([0-9])"));
        assert!(normalized_collector_number_sql("v.e").contains("[A-Za-z]{1,4}"));
    }

    #[test]
    fn sets_dedupe_in_queries() {
        // Mirrors the ids dedupe readCandidatesByCardIds-style callers need.
        let ids: Vec<i64> = vec![1, 2, 2, 3, 0, -1];
        let mut seen = std::collections::HashSet::new();
        let out: Vec<i64> = ids
            .into_iter()
            .filter(|id| *id > 0 && seen.insert(*id))
            .collect();
        assert_eq!(out, vec![1, 2, 3]);
    }
}
