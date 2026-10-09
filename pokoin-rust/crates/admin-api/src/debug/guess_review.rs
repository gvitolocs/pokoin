//! Port of `api/marketplace-cardmarket-guess-review.js` — protected Cardmarket
//! guess review data (verified/manual parsing rows plus expansions without a
//! reusable Cardmarket rule).

use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;

use pokoin_api_common::{http, RouteState};

use super::{db_error, iso_millis, json_object, request_query, HandlerError};

/// `cleanLimit(value, fallback = 160, max = 500)`.
pub(crate) fn clean_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    match value.and_then(http::js_number) {
        Some(limit) if limit.is_finite() => (limit.trunc() as i64).clamp(1, max),
        _ => fallback,
    }
}

/// Verbatim SQL of `cardmarketGuessRows`.
const GUESS_ROWS_SQL: &str = r#"
      with imported as (
        select
          parsing.blueprint_id,
          parsing.cardmarket_locale,
          parsing.card_name,
          parsing.cardmarket_name,
          parsing.expansion_name,
          parsing.cardmarket_expansion_slug,
          parsing.collector_number,
          parsing.normalized_collector_number,
          parsing.cardmarket_set_code,
          parsing.cardmarket_context_code,
          parsing.cardmarket_variant_marker,
          parsing.cardmarket_product_slug,
          parsing.cardmarket_url,
          parsing.verification_method,
          parsing.verification_source,
          parsing.notes,
          parsing.verified_at,
          versions.product_variant,
          coalesce(
            versions.preview_image_url,
            blueprints.preview_image_url,
            versions.cdn_image_url,
            blueprints.cdn_image_url,
            versions.image_url,
            blueprints.image_url
          ) as image_url,
          blueprints.card_market_ids,
          coalesce(cards.card_type, '') as card_type,
          rule.cardmarket_set_code as rule_set_code,
          rule.number_format_rule as rule_number_format_rule,
          rule.source as rule_source
        from public.marketplace_cm_product_parsing parsing
        join public.marketplace_card_versions versions
          on versions.card_id = parsing.blueprint_id
        left join public.cardtrader_pokemon_blueprints blueprints
          on blueprints.id = parsing.blueprint_id
        left join public.marketplace_cards cards
          on cards.card_id = parsing.blueprint_id
        left join public.marketplace_cm_expansion_rules rule
          on rule.expansion_name = parsing.expansion_name
          and rule.cardmarket_locale = parsing.cardmarket_locale
          and rule.applies_to_card_type = case
            when lower(coalesce(cards.card_type, '') || ' ' || coalesce(parsing.card_name, '')) ~ '(trainer|supporter|item|stadium|tool|ball|rod|blender|city)' then 'trainer'
            when lower(coalesce(cards.card_type, '') || ' ' || coalesce(parsing.card_name, '')) like '%energy%' then 'energy'
            else 'pokemon'
          end
        where parsing.match_status in ('verified', 'manual')
          and parsing.verification_source in (
            'cardmarket-tbody-paste',
            'debug-refinement-log',
            'chat',
            'user'
          )
        order by parsing.verified_at desc nulls last, parsing.updated_at desc
        limit $1
      )
      select
        *,
        case
          when cardmarket_set_code = '' then 'exact_only_name_or_special_slug'
          when rule_set_code is null then 'no_reusable_expansion_rule'
          when rule_set_code <> cardmarket_set_code then 'rule_code_differs'
          when cardmarket_variant_marker <> '' then 'variant_marker'
          else 'safe_verified'
        end as review_status
      from imported
    "#;

/// Verbatim SQL of `missingExpansionRows`.
const MISSING_ROWS_SQL: &str = r#"
      with card_rows as (
        select
          versions.expansion_name,
          case
            when lower(coalesce(cards.card_type, '') || ' ' || coalesce(versions.name, '')) ~ '(trainer|supporter|item|stadium|tool|ball|rod|blender|city)' then 'trainer'
            when lower(coalesce(cards.card_type, '') || ' ' || coalesce(versions.name, '')) like '%energy%' then 'energy'
            else 'pokemon'
          end as applies_to_card_type,
          versions.card_id,
          versions.name,
          versions.expansion_number,
          coalesce(
            versions.preview_image_url,
            blueprints.preview_image_url,
            versions.cdn_image_url,
            blueprints.cdn_image_url,
            versions.image_url,
            blueprints.image_url
          ) as image_url
        from public.marketplace_card_versions versions
        left join public.marketplace_cards cards
          on cards.card_id = versions.card_id
        left join public.cardtrader_pokemon_blueprints blueprints
          on blueprints.id = versions.card_id
        where versions.product_type = 'card'
          and versions.expansion_name is not null
      ), grouped as (
        select
          card_rows.expansion_name,
          card_rows.applies_to_card_type,
          count(*)::int as card_count,
          count(link.blueprint_id)::int as verified_count,
          (array_agg(card_rows.card_id order by random()))[1] as sample_blueprint_id,
          (array_agg(card_rows.name order by random()))[1] as sample_name,
          (array_agg(card_rows.expansion_number order by random()))[1] as sample_collector_number,
          (array_agg(card_rows.image_url order by random()))[1] as sample_image_url
        from card_rows
        left join public.marketplace_cm_expansion_rules rule
          on rule.expansion_name = card_rows.expansion_name
          and rule.cardmarket_locale = 'en'
          and rule.applies_to_card_type = card_rows.applies_to_card_type
        left join public.marketplace_cm_verified_links link
          on link.blueprint_id = card_rows.card_id
          and link.cardmarket_locale = 'en'
        where rule.expansion_name is null
        group by card_rows.expansion_name, card_rows.applies_to_card_type
      )
      select *
      from grouped
      order by verified_count desc, card_count desc, expansion_name
      limit $1
    "#;

/// `rowToJson(row)`.
pub(crate) fn row_to_json(row: &GuessRow) -> Value {
    json_object(vec![
        ("blueprintId", Value::String(row.blueprint_id.to_string())),
        (
            "locale",
            Value::String(if row.cardmarket_locale.is_empty() {
                "en".to_owned()
            } else {
                row.cardmarket_locale.clone()
            }),
        ),
        ("name", Value::String(row.card_name.clone())),
        ("cardmarketName", Value::String(row.cardmarket_name.clone())),
        ("expansionName", Value::String(row.expansion_name.clone())),
        (
            "cardmarketExpansionSlug",
            Value::String(row.cardmarket_expansion_slug.clone()),
        ),
        (
            "collectorNumber",
            Value::String(row.collector_number.clone()),
        ),
        (
            "normalizedCollectorNumber",
            Value::String(row.normalized_collector_number.clone()),
        ),
        ("productVariant", Value::String(row.product_variant.clone())),
        ("imageUrl", Value::String(row.image_url.clone())),
        (
            "cardMarketIds",
            Value::Array(
                row.card_market_ids
                    .iter()
                    .map(|id| Value::String(id.clone()))
                    .collect(),
            ),
        ),
        ("cardmarketUrl", Value::String(row.cardmarket_url.clone())),
        (
            "cardmarketProductSlug",
            Value::String(row.cardmarket_product_slug.clone()),
        ),
        (
            "cardmarketSetCode",
            Value::String(row.cardmarket_set_code.clone()),
        ),
        (
            "cardmarketContextCode",
            Value::String(row.cardmarket_context_code.clone()),
        ),
        (
            "cardmarketVariantMarker",
            Value::String(row.cardmarket_variant_marker.clone()),
        ),
        (
            "verificationMethod",
            Value::String(row.verification_method.clone()),
        ),
        (
            "verificationSource",
            Value::String(row.verification_source.clone()),
        ),
        ("notes", Value::String(row.notes.clone())),
        ("verifiedAt", iso_millis(&row.verified_at)),
        ("reviewStatus", Value::String(row.review_status.clone())),
        ("ruleSetCode", Value::String(row.rule_set_code.clone())),
        (
            "ruleNumberFormatRule",
            Value::String(row.rule_number_format_rule.clone()),
        ),
        ("ruleSource", Value::String(row.rule_source.clone())),
    ])
}

pub(crate) struct GuessRow {
    blueprint_id: i64,
    cardmarket_locale: String,
    card_name: String,
    cardmarket_name: String,
    expansion_name: String,
    cardmarket_expansion_slug: String,
    collector_number: String,
    normalized_collector_number: String,
    product_variant: String,
    image_url: String,
    card_market_ids: Vec<String>,
    cardmarket_url: String,
    cardmarket_product_slug: String,
    cardmarket_set_code: String,
    cardmarket_context_code: String,
    cardmarket_variant_marker: String,
    verification_method: String,
    verification_source: String,
    notes: String,
    verified_at: Option<chrono::DateTime<chrono::Utc>>,
    review_status: String,
    rule_set_code: String,
    rule_number_format_rule: String,
    rule_source: String,
}

impl GuessRow {
    fn from_db(row: &sqlx::postgres::PgRow) -> Self {
        let text = |column: &str| -> String {
            row.try_get::<Option<String>, _>(column)
                .unwrap_or_default()
                .unwrap_or_default()
        };
        Self {
            blueprint_id: row.try_get("blueprint_id").unwrap_or(0),
            cardmarket_locale: text("cardmarket_locale"),
            card_name: text("card_name"),
            cardmarket_name: text("cardmarket_name"),
            expansion_name: text("expansion_name"),
            cardmarket_expansion_slug: text("cardmarket_expansion_slug"),
            collector_number: text("collector_number"),
            normalized_collector_number: text("normalized_collector_number"),
            product_variant: text("product_variant"),
            image_url: text("image_url"),
            card_market_ids: row
                .try_get::<Option<Vec<String>>, _>("card_market_ids")
                .unwrap_or_default()
                .unwrap_or_default(),
            cardmarket_url: text("cardmarket_url"),
            cardmarket_product_slug: text("cardmarket_product_slug"),
            cardmarket_set_code: text("cardmarket_set_code"),
            cardmarket_context_code: text("cardmarket_context_code"),
            cardmarket_variant_marker: text("cardmarket_variant_marker"),
            verification_method: text("verification_method"),
            verification_source: text("verification_source"),
            notes: text("notes"),
            verified_at: row.try_get("verified_at").unwrap_or(None),
            review_status: text("review_status"),
            rule_set_code: text("rule_set_code"),
            rule_number_format_rule: text("rule_number_format_rule"),
            rule_source: text("rule_source"),
        }
    }
}

/// `missingRowToJson(row)`.
pub(crate) fn missing_row_to_json(row: &MissingRow) -> Value {
    json_object(vec![
        ("expansionName", Value::String(row.expansion_name.clone())),
        (
            "appliesToCardType",
            Value::String(row.applies_to_card_type.clone()),
        ),
        ("cardCount", json!(row.card_count)),
        ("verifiedCount", json!(row.verified_count)),
        (
            "sampleBlueprintId",
            Value::String(row.sample_blueprint_id.clone()),
        ),
        ("sampleName", Value::String(row.sample_name.clone())),
        (
            "sampleCollectorNumber",
            Value::String(row.sample_collector_number.clone()),
        ),
        (
            "sampleImageUrl",
            Value::String(row.sample_image_url.clone()),
        ),
    ])
}

pub(crate) struct MissingRow {
    expansion_name: String,
    applies_to_card_type: String,
    card_count: i64,
    verified_count: i64,
    sample_blueprint_id: String,
    sample_name: String,
    sample_collector_number: String,
    sample_image_url: String,
}

impl MissingRow {
    fn from_db(row: &sqlx::postgres::PgRow) -> Self {
        let text = |column: &str| -> String {
            row.try_get::<Option<String>, _>(column)
                .unwrap_or_default()
                .unwrap_or_default()
        };
        Self {
            expansion_name: text("expansion_name"),
            applies_to_card_type: text("applies_to_card_type"),
            card_count: row
                .try_get::<Option<i32>, _>("card_count")
                .unwrap_or(None)
                .unwrap_or(0) as i64,
            verified_count: row
                .try_get::<Option<i32>, _>("verified_count")
                .unwrap_or(None)
                .unwrap_or(0) as i64,
            sample_blueprint_id: row
                .try_get::<Option<i64>, _>("sample_blueprint_id")
                .unwrap_or(None)
                .map(|id| id.to_string())
                .unwrap_or_default(),
            sample_name: text("sample_name"),
            sample_collector_number: text("sample_collector_number"),
            sample_image_url: text("sample_image_url"),
        }
    }
}

async fn guess_rows(state: &RouteState, limit: i64) -> Result<Vec<GuessRow>, HandlerError> {
    let rows = sqlx::query(GUESS_ROWS_SQL)
        .bind(limit)
        .fetch_all(state.api.read())
        .await
        .map_err(|error| {
            tracing::error!(message = %super::db_error_message(&error), "marketplace-cardmarket-guess-review failed");
            db_error(error)
        })?;
    Ok(rows.iter().map(GuessRow::from_db).collect())
}

async fn missing_rows(state: &RouteState, limit: i64) -> Result<Vec<MissingRow>, HandlerError> {
    let rows = sqlx::query(MISSING_ROWS_SQL)
        .bind(limit)
        .fetch_all(state.api.read())
        .await
        .map_err(|error| {
            tracing::error!(message = %super::db_error_message(&error), "marketplace-cardmarket-guess-review failed");
            db_error(error)
        })?;
    Ok(rows.iter().map(MissingRow::from_db).collect())
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if method != Method::GET {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET")],
        );
    }

    if let Err(error) = state.require_debug_admin(&headers).await {
        return error;
    }
    let query = request_query(&uri);
    let limit = clean_limit(query.first("limit"), 160, 500);
    let missing_limit = clean_limit(query.first("missingLimit"), 120, 300);

    // `Promise.all([...])` — the two reads run concurrently and any failure
    // rejects the whole request.
    let (guesses, missing) = tokio::join!(
        guess_rows(&state, limit),
        missing_rows(&state, missing_limit)
    );
    let guesses = match guesses {
        Ok(rows) => rows,
        Err(error) => return error.into_response_with(&[]),
    };
    let missing = match missing {
        Ok(rows) => rows,
        Err(error) => return error.into_response_with(&[]),
    };

    let guesses_json: Vec<Value> = guesses.iter().map(row_to_json).collect();
    let risky: Vec<Value> = guesses
        .iter()
        .filter(|row| row.review_status != "safe_verified")
        .map(row_to_json)
        .collect();
    let missing_json: Vec<Value> = missing.iter().map(missing_row_to_json).collect();

    http::json(
        StatusCode::OK,
        json!({
            "generatedAt": super::now_iso(),
            "guesses": guesses_json,
            "riskyGuesses": risky,
            "missingExpansions": missing_json,
        }),
    )
}
