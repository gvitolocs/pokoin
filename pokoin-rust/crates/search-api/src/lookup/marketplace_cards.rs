//! `GET /api/marketplace-cards` — port of `marketplace-cards.js` (search page
//! grid and the Products facet counts).

use std::sync::LazyLock;

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use pokoin_catalog_api::reads::util;
use pokoin_catalog_api::shared::{card_rarity, card_versions, image_log, js, row as catalog_row};
use regex::Regex;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::autocomplete::engine::{self, Ctx};
use crate::autocomplete::rank::rank_autocomplete_rows;
use crate::autocomplete::{analytics, row};

fn number_or_nan(raw: Option<&str>) -> f64 {
    match raw {
        None => 0.0,
        Some(text) => http::js_number(text).unwrap_or(f64::NAN),
    }
}

fn clean_limit(raw: Option<&str>) -> i64 {
    let n = number_or_nan(raw);
    if !n.is_finite() { 240 } else { (n.trunc() as i64).clamp(1, 1000) }
}

fn clean_search_page_limit(raw: Option<&str>) -> i64 {
    let n = number_or_nan(raw);
    if !n.is_finite() { 100 } else { (n.trunc() as i64).clamp(1, 100) }
}

fn clean_offset(raw: Option<&str>) -> i64 {
    let n = number_or_nan(raw);
    if !n.is_finite() { 0 } else { (n.trunc() as i64).clamp(0, 10_000) }
}

fn clean_text(value: Option<&str>, max: usize) -> String {
    js::clean_text_str(value.unwrap_or(""), max)
}

static PLURAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)([a-z0-9]+)s(?-u:\b)").unwrap());
static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

/// `searchTerms(value)` of marketplace-cards.js.
pub fn search_terms(value: Option<&str>) -> Vec<String> {
    let lower = clean_text(value, 120).to_lowercase();
    let replaced = PLURAL.replace_all(&lower, "$1's");
    SPLIT
        .split(&replaced)
        .map(str::trim)
        .filter(|t| t.chars().count() >= 2 || (!t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())))
        .map(str::to_owned)
        .collect()
}

fn clean_language(value: Option<&str>) -> String {
    let raw = value.filter(|v| !v.is_empty()).unwrap_or("en");
    let language = raw.trim().to_lowercase();
    let b = language.as_bytes();
    let ok = (b.len() == 2 && b.iter().all(u8::is_ascii_lowercase))
        || (b.len() == 5 && b[..2].iter().all(u8::is_ascii_lowercase) && b[2] == b'-' && b[3..].iter().all(u8::is_ascii_lowercase));
    if ok { language } else { "en".into() }
}

fn has_structured_name_number_query(query: Option<&str>) -> bool {
    let terms = search_terms(query);
    let numeric = |t: &String| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    terms.iter().any(numeric) && terms.iter().any(|t| !numeric(t))
}

fn product_type_clause(product_type: Option<&str>, product_search_only: bool, values: &mut Vec<Bind>) -> String {
    let normalized = clean_text(product_type, 60);
    if !normalized.is_empty() {
        values.push(Bind::Text(normalized));
        return format!(" and marketplace_search_candidates.product_type = ${}", values.len());
    }
    if product_search_only {
        return " and (marketplace_search_candidates.item_kind = 'product' or marketplace_search_candidates.product_type = 'jumbo')".into();
    }
    String::new()
}

fn search_clause(query: Option<&str>, product_search_only: bool, search_language: Option<&str>, values: &mut Vec<Bind>) -> String {
    let terms = search_terms(query);
    if terms.is_empty() {
        return String::new();
    }
    let fields: &[&str] = if product_search_only {
        &[
            "marketplace_search_candidates.name",
            "marketplace_search_candidates.set_name",
            "marketplace_search_candidates.product_variant",
            "marketplace_search_candidates.trainer_name",
        ]
    } else {
        &[
            "marketplace_search_candidates.name",
            "marketplace_search_candidates.set_name",
            "marketplace_search_candidates.trainer_name",
            "marketplace_search_candidates.card_type",
            "marketplace_search_candidates.rarity",
            "marketplace_search_candidates.card_number",
            "marketplace_search_candidates.product_variant",
        ]
    };
    let clauses: Vec<String> = terms
        .iter()
        .map(|term| {
            values.push(Bind::Text(format!("%{term}%")));
            let placeholder = format!("${}", values.len());
            values.push(Bind::Text(clean_language(search_language)));
            let language_placeholder = format!("${}", values.len());
            let ors = fields.iter().map(|f| format!("{f} ilike {placeholder}")).collect::<Vec<_>>().join(" or ");
            format!(
                "({ors}
      or exists (
        select 1
        from public.marketplace_card_name_translations translations
        where translations.language = {language_placeholder}
          and translations.name = marketplace_search_candidates.name
          and translations.localized_name ilike {placeholder}
      ))"
            )
        })
        .collect();
    format!(" and {}", clauses.join(" and "))
}

fn watchlist_join(c: &str, a: &str) -> String {
    format!(
        "
    left join public.marketplace_card_watchlist_analytics {a}
      on (
        {a}.blueprint_id = {c}.ct_id
        or {a}.blueprint_id = {c}.card_id
      )
  "
    )
}

fn cart_join(c: &str, a: &str) -> String {
    format!(
        "
    left join public.marketplace_card_cart_analytics {a}
      on (
        {a}.blueprint_id = {c}.ct_id
        or {a}.blueprint_id = {c}.card_id
      )
  "
    )
}

fn pkn_usdt_price() -> String {
    std::env::var("PKN_CHECKOUT_USDT_PRICE").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "0.005".into())
}

fn finish_row(mut row: Value, drop: &str) -> Value {
    if let Value::Object(map) = &mut row {
        map.remove(drop);
    }
    row::with_card_emoji_fields(&catalog_row::normalize_marketplace_row(&row))
}

pub struct Error(pub String);

impl From<sqlx::Error> for Error {
    fn from(error: sqlx::Error) -> Self {
        tracing::error!(%error, "marketplace-cards query failed");
        match error {
            sqlx::Error::Database(db) => Error(db.message().to_owned()),
            other => Error(other.to_string()),
        }
    }
}

impl From<engine::EngineError> for Error {
    fn from(error: engine::EngineError) -> Self {
        Error(error.message)
    }
}

async fn fallback_rows_for_structured_cards(state: &RouteState, pool: &PgPool, query: Option<&str>, limit: Option<&str>, search_language: &str) -> Result<Vec<Value>, Error> {
    if !has_structured_name_number_query(query) {
        return Ok(Vec::new());
    }
    let query = query.unwrap_or("");
    let result_limit = clean_limit(limit);
    let rarity_sql = card_rarity::projected_rarity_sql("c.rarity", "coalesce(nullif(c.card_number, ''), ranked.card_number)", "blueprints", "tcg_metadata");
    let redis = state.api.redis().await;
    let mut ctx = Ctx::new(pool.clone(), redis.clone());
    let candidates = engine::rows_for_autocomplete_search_term_with_query(&mut ctx, redis, query, (result_limit * 8).clamp(100, 500), search_language, None, None).await?;
    let ranked = rank_autocomplete_rows(candidates.rows, query, result_limit as usize, &analytics::empty_analytics_boosts(), &Default::default(), &Default::default(), &Default::default());
    let ids: Vec<i64> = ranked
        .iter()
        .map(|r| js::number(r.get("card_id")))
        .filter(|n| js::is_safe_integer(*n) && *n > 0.0)
        .map(|n| n as i64)
        .collect();
    // Node filters ids but maps card_number over every ranked row; unnest pairs
    // them positionally, so keep the full card_number list like the JS.
    let all_numbers: Vec<String> = ranked.iter().map(|r| js::string_or_empty(r.get("card_number"))).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let relation = card_versions::cheapest_homepage_cache_relation_name(pool).await?;
    let sql = format!(
        "
      with settings as (
        select set_config('app.pkn_usdt_price', $2::text, true)
      )
      select
        c.card_id, c.name, c.product_variant as version, c.image_url, c.cdn_image_url,
        c.preview_image_url, c.set_name, {rarity_sql} as rarity, c.card_type,
        coalesce(nullif(c.card_number, ''), ranked.card_number) as card_number,
        c.product_variant, false as is_holo, false as is_foil, c.item_kind, c.product_type,
        c.trainer_name, c.artist, c.illustrator,
        c.card_palette, c.emoji, c.imported_at,
        coalesce(watchlist_analytics.watchlist_count, 0) as watchlist_count,
        coalesce(cart_analytics.cart_holder_count, 0) as cart_holder_count,
        {availability},
        ranked.ordinality
      from settings,
        unnest($1::bigint[], $3::text[]) with ordinality as ranked(card_id, card_number, ordinality)
      join public.marketplace_search_candidates c on c.card_id = ranked.card_id
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = coalesce(c.ct_id, c.card_id)
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = c.card_id
        or tcg_metadata.blueprint_id = coalesce(c.ct_id, c.card_id)
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = coalesce(c.ct_id, c.card_id)
      {ct_join}
      {wl_join}
      {cart}
      order by ranked.ordinality
    ",
        availability = card_versions::availability_columns("price_summary", "cardtrader"),
        ct_join = card_versions::card_trader_availability_join("c", &relation),
        wl_join = watchlist_join("c", "watchlist_analytics"),
        cart = cart_join("c", "cart_analytics"),
    );
    let rows = pg::pool_rows(pool, &sql, &[Bind::BigIntArray(ids), Bind::Text(pkn_usdt_price()), Bind::TextArray(all_numbers)]).await?;
    Ok(rows.into_iter().map(|r| finish_row(r, "ordinality")).collect())
}

pub struct CardsInput<'a> {
    pub query: Option<&'a str>,
    pub limit: Option<&'a str>,
    pub offset: Option<&'a str>,
    pub product_type: Option<&'a str>,
    pub product_search_only: bool,
    pub search_language: Option<&'a str>,
}

pub async fn rows_for_cards(state: &RouteState, input: CardsInput<'_>) -> Result<Vec<Value>, Error> {
    let pool = state.api.read().clone();
    let name_query = clean_text(input.query, 120);
    let typed_product = clean_text(input.product_type, 60);
    let language = clean_language(input.search_language);
    if !name_query.is_empty() && !input.product_search_only && typed_product != "jumbo" && engine::use_meili_search_for_language(&language) {
        let redis = state.api.redis().await;
        let mut ctx = Ctx::new(pool.clone(), redis.clone());
        let rows = engine::rows_for_search_term(&mut ctx, redis, &name_query, clean_search_page_limit(input.limit), clean_offset(input.offset), &language, false).await?;
        if typed_product.is_empty() {
            return Ok(rows);
        }
        return Ok(rows.into_iter().filter(|r| js::string_or_empty(r.get("product_type")) == typed_product).collect());
    }
    let mut values = Vec::new();
    let rarity_sql = card_rarity::projected_rarity_sql(
        "marketplace_search_candidates.rarity",
        "marketplace_search_candidates.card_number",
        "blueprints",
        "tcg_metadata",
    );
    let mut where_sql = "where coalesce(marketplace_search_candidates.preview_image_url, marketplace_search_candidates.cdn_image_url, marketplace_search_candidates.image_url) is not null".to_owned();
    where_sql += &product_type_clause(input.product_type, input.product_search_only, &mut values);
    where_sql += &search_clause(input.query, input.product_search_only, input.search_language, &mut values);
    values.push(Bind::Int(clean_limit(input.limit)));
    values.push(Bind::Text(pkn_usdt_price()));
    let limit_index = values.len() - 1;
    let relation = card_versions::cheapest_homepage_cache_relation_name(&pool).await?;
    let sql = format!(
        "
      with settings as (
        select set_config('app.pkn_usdt_price', ${price_index}::text, true)
      )
      select
        marketplace_search_candidates.card_id,
        marketplace_search_candidates.name,
        marketplace_search_candidates.product_variant as version,
        marketplace_search_candidates.image_url,
        marketplace_search_candidates.cdn_image_url,
        marketplace_search_candidates.preview_image_url,
        marketplace_search_candidates.set_name,
        (
          select e.nationality
          from public.pokoin_pokemon_expansions e
          where e.name = marketplace_search_candidates.set_name
             or e.normalized_name = public.marketplace_search_normalize(marketplace_search_candidates.set_name)
          order by case when e.name = marketplace_search_candidates.set_name then 0 else 1 end
          limit 1
        ) as nationality,
        {rarity_sql} as rarity,
        marketplace_search_candidates.card_type,
        marketplace_search_candidates.card_number,
        marketplace_search_candidates.product_variant,
        false as is_holo,
        false as is_foil,
        marketplace_search_candidates.item_kind,
        marketplace_search_candidates.product_type,
        marketplace_search_candidates.trainer_name,
        marketplace_search_candidates.artist,
        marketplace_search_candidates.illustrator,
        marketplace_search_candidates.card_palette,
        marketplace_search_candidates.emoji,
        marketplace_search_candidates.imported_at,
        coalesce(watchlist_analytics.watchlist_count, 0) as watchlist_count,
        coalesce(cart_analytics.cart_holder_count, 0) as cart_holder_count,
        {availability}
      from settings,
        public.marketplace_search_candidates
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = coalesce(marketplace_search_candidates.ct_id, marketplace_search_candidates.card_id)
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.card_id = marketplace_search_candidates.card_id
        or tcg_metadata.blueprint_id = coalesce(marketplace_search_candidates.ct_id, marketplace_search_candidates.card_id)
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = coalesce(marketplace_search_candidates.ct_id, marketplace_search_candidates.card_id)
      {ct_join}
      {wl_join}
      {cart}
      {where_sql}
      order by marketplace_search_candidates.search_weight desc,
        marketplace_search_candidates.imported_at desc nulls last,
        marketplace_search_candidates.card_id desc
      limit ${limit_index}
    ",
        price_index = values.len(),
        availability = card_versions::availability_columns("price_summary", "cardtrader"),
        ct_join = card_versions::card_trader_availability_join("marketplace_search_candidates", &relation),
        wl_join = watchlist_join("marketplace_search_candidates", "watchlist_analytics"),
        cart = cart_join("marketplace_search_candidates", "cart_analytics"),
    );
    let rows = pg::pool_rows(&pool, &sql, &values).await?;
    if !rows.is_empty() || !typed_product.is_empty() || input.product_search_only {
        return Ok(rows.into_iter().map(|r| finish_row(r, "total_count")).collect());
    }
    fallback_rows_for_structured_cards(state, &pool, input.query, input.limit, &language).await
}

pub async fn product_facet_rows(pool: &PgPool, query: Option<&str>, search_language: Option<&str>) -> Result<Vec<Value>, Error> {
    let mut values = Vec::new();
    let mut where_sql = "where coalesce(marketplace_search_candidates.preview_image_url, marketplace_search_candidates.cdn_image_url, marketplace_search_candidates.image_url) is not null".to_owned();
    where_sql += &search_clause(query, false, search_language, &mut values);
    let sql = format!(
        "
      with product_facets as (
        select
          case
    when marketplace_search_candidates.item_kind = 'product'
      then coalesce(nullif(marketplace_search_candidates.product_type, ''), 'sealed_product')
    else 'card'
  end as product_type,
          count(*)::integer as count
        from public.marketplace_search_candidates
        {where_sql}
        group by 1
      )
      select product_type, count
      from product_facets
      order by
        case
          when product_type = 'card' then 0
          when product_type = 'booster_box' then 10
          when product_type = 'booster_pack' then 20
          else 100
        end asc,
        count desc,
        product_type asc
    "
    );
    let rows = pg::pool_rows(pool, &sql, &values).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let count = if js::truthy(r.get("count")) { js::number(r.get("count")) } else { 0.0 };
            json!({ "productType": js::string_or_empty(r.get("product_type")), "count": pg::js_number(count) })
        })
        .filter(|r| !js::string_or_empty(r.get("productType")).is_empty() && js::number(r.get("count")) > 0.0)
        .collect())
}

fn first_truthy<'a>(q: &'a http::Query, keys: &[&str]) -> Option<&'a str> {
    util::first_of(q, keys)
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let query = first_truthy(&q, &["query", "q"]);
    let search_language = first_truthy(&q, &["search_language", "lang", "language"]);
    let failed = |error: Error| {
        let message = if error.0.is_empty() { "Marketplace cards failed.".to_owned() } else { error.0 };
        http::json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": message }))
    };
    if q.search_param("facets") == Some("products") {
        return match product_facet_rows(state.api.read(), query, search_language).await {
            Ok(products) => util::json_cache(StatusCode::OK, json!({ "products": products }), "public, max-age=20, s-maxage=120"),
            Err(error) => failed(error),
        };
    }
    let input = CardsInput {
        query,
        limit: q.search_param("limit"),
        offset: q.search_param("offset"),
        product_type: q.search_param("productType"),
        product_search_only: q.search_param("productSearchOnly") == Some("1"),
        search_language,
    };
    match rows_for_cards(&state, input).await {
        Ok(rows) => {
            let payload: Vec<Value> = rows.iter().map(catalog_row::normalize_marketplace_row).collect();
            let route = format!("{}{}", uri.path(), uri.query().map(|s| format!("?{s}")).unwrap_or_default());
            image_log::record_cards_images(&payload, &route);
            util::json_cache(StatusCode::OK, Value::Array(payload), "public, max-age=20, s-maxage=120")
        }
        Err(error) => failed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terms_and_limits() {
        assert_eq!(search_terms(Some("Charizards ex 4")), vec!["charizard", "ex", "4"]);
        assert!(has_structured_name_number_query(Some("pikachu 25")));
        assert!(!has_structured_name_number_query(Some("pikachu")));
        assert_eq!(clean_limit(None), 1);
        assert_eq!(clean_limit(Some("abc")), 240);
        assert_eq!(clean_search_page_limit(Some("500")), 100);
        assert_eq!(clean_offset(Some("-4")), 0);
        assert_eq!(clean_language(Some("EN-us")), "en-us");
    }
}
