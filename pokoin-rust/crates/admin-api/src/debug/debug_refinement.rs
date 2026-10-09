//! Port of `api/marketplace-debug-refinement.js` — random Cardmarket
//! candidate/verified review rows plus the refinement-log write that promotes
//! a pasted Cardmarket URL into `public.marketplace_cm_verified_links`.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;

use pokoin_api_common::{http, RouteState};

use super::cm_candidates::{self, RedirectRow};
use super::{
    clean_blueprint_id_value, clean_text_value, db_error_message, internal_error, iso_millis,
    json_object, request_query, truncate_utf16, value_get, DebugUser,
};

/// `cleanLimit(value)` — note the Node quirk: a missing query param is `null`
/// and `Number(null)` is 0, so the default only applies to non-numeric text.
pub(crate) fn clean_limit(value: Option<&str>) -> i64 {
    let number = match value {
        None => Some(0.0),
        Some(text) => http::js_number(text),
    };
    match number {
        Some(limit) if limit.is_finite() => (limit.trunc() as i64).clamp(1, 1000),
        _ => 1000,
    }
}

/// `cleanLocale(value)`.
pub(crate) fn clean_locale(value: Option<&str>) -> String {
    let locale = value.unwrap_or("en").trim().to_lowercase();
    if locale.len() == 2 && locale.bytes().all(|byte| byte.is_ascii_lowercase()) {
        locale
    } else {
        "en".to_owned()
    }
}

/// `cleanCardmarketUrl(value)` of this handler (https, cardmarket host,
/// `/en/Pokemon/Products/Singles` prefix, hash stripped).
pub(crate) fn clean_cardmarket_url(value: &Value) -> String {
    let text = clean_text_value(value, 600);
    let parsed = match reqwest::Url::parse(&text) {
        Ok(parsed) => parsed,
        Err(_) => return String::new(),
    };
    if parsed.scheme() != "https" {
        return String::new();
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "www.cardmarket.com" && host != "cardmarket.com" {
        return String::new();
    }
    if !parsed.path().starts_with("/en/Pokemon/Products/Singles") {
        return String::new();
    }
    let mut parsed = parsed;
    parsed.set_fragment(None);
    parsed.as_str().to_owned()
}

/// `cleanStringArray(value)`.
pub(crate) fn clean_string_array(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|entry| clean_text_value(entry, 80))
            .filter(|entry| !entry.is_empty())
            .take(12)
            .collect(),
        _ => vec![],
    }
}

/// `ensureRefinementLogTable()` — the Node handler runs these guards through
/// `marketplaceQuery`, i.e. the read pool.
async fn ensure_refinement_log_table(state: &RouteState) -> Result<(), Response> {
    for statement in [
        r#"
    create table if not exists public.marketplace_cm_refinement_log (
      id bigserial primary key,
      blueprint_id bigint not null references public.cardtrader_pokemon_blueprints(id) on delete cascade,
      cardmarket_locale text not null default 'en',
      pasted_cardmarket_url text not null,
      candidate_cardmarket_url text not null default '',
      card_name text not null default '',
      expansion_name text not null default '',
      collector_number text not null default '',
      cardmarket_ids text[] not null default '{}',
      status text not null default 'pending' check (
        status in ('pending', 'implemented', 'rejected')
      ),
      debug_uid text not null default '',
      debug_email text not null default '',
      debug_username text not null default '',
      notes text not null default '',
      created_at timestamptz not null default now(),
      implemented_at timestamptz
    )
  "#,
        r#"
    create index if not exists marketplace_cm_refinement_log_blueprint_idx
      on public.marketplace_cm_refinement_log (blueprint_id, status, created_at desc)
  "#,
        r#"
    create index if not exists marketplace_cm_refinement_log_status_idx
      on public.marketplace_cm_refinement_log (status, created_at desc)
  "#,
        r#"
    create table if not exists public.marketplace_cm_verified_links (
      blueprint_id bigint not null references public.cardtrader_pokemon_blueprints(id) on delete cascade,
      cardmarket_locale text not null default 'en',
      cardmarket_url text not null,
      cardmarket_product_slug text not null default '',
      card_name text not null default '',
      expansion_name text not null default '',
      collector_number text not null default '',
      source text not null default '',
      confidence text not null default 'verified' check (
        confidence in ('verified', 'manual')
      ),
      notes text not null default '',
      verified_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (blueprint_id, cardmarket_locale)
    )
  "#,
        r#"
    create unique index if not exists marketplace_cm_verified_links_url_idx
      on public.marketplace_cm_verified_links (cardmarket_url)
  "#,
    ] {
        sqlx::query(statement)
            .execute(state.api.read())
            .await
            .map_err(|error| internal_error(&db_error_message(&error)))?;
    }
    Ok(())
}

/// `randomRows(limit, locale)`.
async fn random_rows(
    state: &RouteState,
    limit: i64,
    locale: &str,
) -> Result<Vec<RefinementRow>, Response> {
    let verified_limit = ((limit as f64) * 0.35).floor().max(1.0) as i64;
    let candidate_limit = (limit - verified_limit).max(1);
    let rows = sqlx::query(REFINEMENT_ROWS_SQL)
        .bind(candidate_limit)
        .bind(verified_limit)
        .bind(locale)
        .fetch_all(state.api.read())
        .await
        .map_err(|error| internal_error(&db_error_message(&error)))?;
    Ok(rows.iter().map(RefinementRow::from_db).collect())
}

/// Verbatim SQL of `randomRows`.
const REFINEMENT_ROWS_SQL: &str = r#"
      with base as (
        select
          versions.card_id,
          versions.name,
          versions.expansion_name,
          versions.expansion_number,
          versions.product_variant,
          versions.product_type,
          coalesce(
            versions.preview_image_url,
            blueprints.preview_image_url,
            versions.cdn_image_url,
            blueprints.cdn_image_url,
            versions.image_url,
            blueprints.image_url
          ) as image_url,
          blueprints.card_market_ids,
          coalesce(product_parsing.cardmarket_url, '') as stored_cardmarket_url,
          coalesce(product_parsing.match_status, '') as stored_match_status
        from public.marketplace_card_versions versions
        left join public.cardtrader_pokemon_blueprints blueprints
          on blueprints.id = versions.card_id
        left join lateral (
          select cardmarket_url, match_status, priority, verified_at, updated_at
          from (
            select
              link.cardmarket_url,
              link.confidence as match_status,
              0 as priority,
              link.verified_at,
              link.updated_at
            from public.marketplace_cm_verified_links link
            where link.blueprint_id = versions.card_id
              and link.cardmarket_locale = $3
              and link.confidence in ('verified', 'manual')
            union all
            select
              parsing.cardmarket_url,
              parsing.match_status,
              1 as priority,
              parsing.verified_at,
              parsing.updated_at
            from public.marketplace_cm_product_parsing parsing
            where parsing.blueprint_id = versions.card_id
              and parsing.cardmarket_locale = $3
              and parsing.match_status in ('verified', 'manual')
          ) stored
          order by priority, verified_at desc nulls last, updated_at desc
          limit 1
        ) product_parsing on true
        where versions.product_type = 'card'
          and versions.name is not null
          and versions.expansion_name is not null
          and versions.expansion_number is not null
      ), candidate_rows as (
        select *, 'candidate_review' as review_bucket
        from base
        where stored_cardmarket_url = ''
        order by random()
        limit $1
      ), verified_rows as (
        select *, 'verified_audit' as review_bucket
        from base
        where stored_cardmarket_url <> ''
        order by random()
        limit $2
      )
      select *
      from (
        select * from candidate_rows
        union all
        select * from verified_rows
      ) rows
      order by random()
    "#;

struct RefinementRow {
    card_id: i64,
    name: String,
    expansion_name: String,
    expansion_number: String,
    product_variant: String,
    image_url: String,
    card_market_ids: Vec<String>,
    stored_cardmarket_url: String,
    stored_match_status: String,
    review_bucket: String,
}

impl RefinementRow {
    fn from_db(row: &sqlx::postgres::PgRow) -> Self {
        let text = |column: &str| -> String {
            row.try_get::<Option<String>, _>(column)
                .unwrap_or_default()
                .unwrap_or_default()
        };
        Self {
            card_id: row.try_get("card_id").unwrap_or(0),
            name: text("name"),
            expansion_name: text("expansion_name"),
            expansion_number: text("expansion_number"),
            product_variant: text("product_variant"),
            image_url: text("image_url"),
            card_market_ids: row
                .try_get::<Option<Vec<String>>, _>("card_market_ids")
                .unwrap_or_default()
                .unwrap_or_default(),
            stored_cardmarket_url: text("stored_cardmarket_url"),
            stored_match_status: text("stored_match_status"),
            review_bucket: text("review_bucket"),
        }
    }

    fn to_redirect_row(&self) -> RedirectRow {
        RedirectRow {
            card_id: self.card_id.to_string(),
            name: self.name.clone(),
            expansion_name: self.expansion_name.clone(),
            expansion_number: self.expansion_number.clone(),
            product_variant: self.product_variant.clone(),
            ..Default::default()
        }
    }
}

/// `saveRefinementLog(body, user, locale)`.
async fn save_refinement_log(
    state: &RouteState,
    body: &Value,
    user: &DebugUser,
    locale: &str,
) -> Result<Value, Response> {
    let blueprint_id = clean_blueprint_id_value(value_get(body, "blueprintId"));
    let pasted_url = clean_cardmarket_url(value_get(body, "cardmarketUrl"));
    if blueprint_id == 0 || pasted_url.is_empty() {
        return Err(http::json(
            StatusCode::BAD_REQUEST,
            json!({ "error": "Paste a valid Cardmarket singles URL for this blueprint." }),
        ));
    }
    ensure_refinement_log_table(state).await?;
    let candidate = clean_text_value(value_get(body, "candidateCardmarketUrl"), 600);
    let card_name = clean_text_value(value_get(body, "cardName"), 240);
    let expansion_name = clean_text_value(value_get(body, "expansionName"), 240);
    let collector_number = clean_text_value(value_get(body, "collectorNumber"), 120);
    let cardmarket_ids = clean_string_array(value_get(body, "cardMarketIds"));
    let notes = clean_text_value(value_get(body, "notes"), 500);
    let row = sqlx::query(
        r#"
      insert into public.marketplace_cm_refinement_log (
        blueprint_id,
        cardmarket_locale,
        pasted_cardmarket_url,
        candidate_cardmarket_url,
        card_name,
        expansion_name,
        collector_number,
        cardmarket_ids,
        debug_uid,
        debug_email,
        debug_username,
        notes
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12)
      returning id, created_at
    "#,
    )
    .bind(blueprint_id)
    .bind(locale)
    .bind(&pasted_url)
    .bind(&candidate)
    .bind(&card_name)
    .bind(&expansion_name)
    .bind(&collector_number)
    .bind(&cardmarket_ids)
    .bind(truncate_utf16(user.uid.trim(), 160))
    .bind(truncate_utf16(user.email.trim(), 240))
    .bind(truncate_utf16(user.username.trim(), 120))
    .bind(&notes)
    .fetch_one(state.api.read())
    .await
    .map_err(|error| internal_error(&db_error_message(&error)))?;

    let log_id: i64 = row.try_get("id").unwrap_or(0);
    let created_at: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("created_at").unwrap_or(None);

    let slug = pasted_url
        .split('/')
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or("")
        .to_owned();
    sqlx::query(
        r#"
      insert into public.marketplace_cm_verified_links (
        blueprint_id,
        cardmarket_locale,
        cardmarket_url,
        cardmarket_product_slug,
        card_name,
        expansion_name,
        collector_number,
        source,
        confidence,
        notes,
        verified_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'debug-refinement-log', 'manual', $8, now())
      on conflict (blueprint_id, cardmarket_locale)
      do update set
        cardmarket_url = excluded.cardmarket_url,
        cardmarket_product_slug = excluded.cardmarket_product_slug,
        card_name = excluded.card_name,
        expansion_name = excluded.expansion_name,
        collector_number = excluded.collector_number,
        source = excluded.source,
        confidence = excluded.confidence,
        notes = excluded.notes,
        verified_at = excluded.verified_at,
        updated_at = now()
    "#,
    )
    .bind(blueprint_id)
    .bind(locale)
    .bind(&pasted_url)
    .bind(&slug)
    .bind(&card_name)
    .bind(&expansion_name)
    .bind(&collector_number)
    .bind(format!("Auto-promoted from refinement log {log_id}."))
    .execute(state.api.read())
    .await
    .map_err(|error| internal_error(&db_error_message(&error)))?;

    Ok(json!({
        "id": log_id.to_string(),
        "created_at": iso_millis(&created_at),
    }))
}

/// `confirmCurrentUrl(body, user, locale)`.
async fn confirm_current_url(
    state: &RouteState,
    body: &Value,
    user: &DebugUser,
    locale: &str,
) -> Result<Value, Response> {
    let blueprint_id = clean_blueprint_id_value(value_get(body, "blueprintId"));
    let cardmarket_url = clean_cardmarket_url(value_get(body, "cardmarketUrl"));
    if blueprint_id == 0 || cardmarket_url.is_empty() {
        return Err(http::json(
            StatusCode::BAD_REQUEST,
            json!({ "error": "A valid current Cardmarket singles URL is required." }),
        ));
    }
    ensure_refinement_log_table(state).await?;
    let slug = cardmarket_url
        .split('/')
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or("")
        .to_owned();
    let card_name = clean_text_value(value_get(body, "cardName"), 240);
    let expansion_name = clean_text_value(value_get(body, "expansionName"), 240);
    let collector_number = clean_text_value(value_get(body, "collectorNumber"), 120);
    let confirmed_by = {
        let label = if user.email.is_empty() {
            user.username.clone()
        } else {
            user.email.clone()
        };
        clean_text_value(&Value::String(label), 240)
    };
    let row = sqlx::query(
        r#"
      insert into public.marketplace_cm_verified_links (
        blueprint_id,
        cardmarket_locale,
        cardmarket_url,
        cardmarket_product_slug,
        card_name,
        expansion_name,
        collector_number,
        source,
        confidence,
        notes,
        verified_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, 'debug-refinement-confirm-ok', 'verified', $8, now())
      on conflict (blueprint_id, cardmarket_locale)
      do update set
        cardmarket_url = excluded.cardmarket_url,
        cardmarket_product_slug = excluded.cardmarket_product_slug,
        card_name = excluded.card_name,
        expansion_name = excluded.expansion_name,
        collector_number = excluded.collector_number,
        source = excluded.source,
        confidence = excluded.confidence,
        notes = excluded.notes,
        verified_at = excluded.verified_at,
        updated_at = now()
      returning blueprint_id, cardmarket_locale, cardmarket_url, verified_at
    "#,
    )
    .bind(blueprint_id)
    .bind(locale)
    .bind(&cardmarket_url)
    .bind(&slug)
    .bind(&card_name)
    .bind(&expansion_name)
    .bind(&collector_number)
    .bind(format!(
        "Confirmed already OK by {confirmed_by} from debug refinement."
    ))
    .fetch_one(state.api.read())
    .await
    .map_err(|error| internal_error(&db_error_message(&error)))?;

    let verified_at: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("verified_at").unwrap_or(None);
    Ok(json_object(vec![
        (
            "blueprint_id",
            Value::String(
                row.try_get::<i64, _>("blueprint_id")
                    .unwrap_or(0)
                    .to_string(),
            ),
        ),
        (
            "cardmarket_locale",
            Value::String(
                row.try_get::<Option<String>, _>("cardmarket_locale")
                    .unwrap_or_default()
                    .unwrap_or_default(),
            ),
        ),
        (
            "cardmarket_url",
            Value::String(
                row.try_get::<Option<String>, _>("cardmarket_url")
                    .unwrap_or_default()
                    .unwrap_or_default(),
            ),
        ),
        ("verified_at", iso_millis(&verified_at)),
    ]))
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if method != Method::GET && method != Method::POST {
        return http::json_with(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "GET, POST")],
        );
    }

    let user = match state.require_debug_admin(&headers).await {
        Ok(claims) => DebugUser::from_claims(&claims),
        Err(error) => return error,
    };
    let query = request_query(&uri);
    let locale = clean_locale(query.first("locale"));

    if method == Method::POST {
        let parsed = match http::parse_body(&headers, &body) {
            Ok(parsed) => parsed.json(),
            Err(error) => return error,
        };
        if value_get(&parsed, "action").as_str() == Some("confirm_current_url") {
            return match confirm_current_url(&state, &parsed, &user, &locale).await {
                Ok(confirmed) => http::json_with(
                    StatusCode::OK,
                    json!({ "ok": true, "confirmed": confirmed }),
                    &[("cache-control", "no-store")],
                ),
                Err(error) => error,
            };
        }
        return match save_refinement_log(&state, &parsed, &user, &locale).await {
            Ok(log) => http::json_with(
                StatusCode::CREATED,
                json!({ "ok": true, "log": log }),
                &[("cache-control", "no-store")],
            ),
            Err(error) => error,
        };
    }

    let rows = match random_rows(&state, clean_limit(query.first("limit")), &locale).await {
        Ok(rows) => rows,
        Err(error) => return error,
    };
    let payload: Vec<Value> = rows
        .iter()
        .map(|row| {
            let candidates = cm_candidates::candidate_urls(&row.to_redirect_row(), &locale);
            let direct_url = if row.stored_cardmarket_url.is_empty() {
                candidates.first().cloned().unwrap_or_default()
            } else {
                row.stored_cardmarket_url.clone()
            };
            json_object(vec![
                ("blueprintId", Value::String(row.card_id.to_string())),
                ("name", Value::String(row.name.clone())),
                ("expansionName", Value::String(row.expansion_name.clone())),
                (
                    "collectorNumber",
                    Value::String(row.expansion_number.clone()),
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
                ("cardmarketUrl", Value::String(direct_url)),
                (
                    "cardmarketRedirectUrl",
                    Value::String(format!(
                        "/api/cardmarket-redirect?id={}",
                        urlencoding::encode(&row.card_id.to_string())
                    )),
                ),
                (
                    "status",
                    Value::String(if row.stored_cardmarket_url.is_empty() {
                        "candidate".to_owned()
                    } else if row.stored_match_status.is_empty() {
                        "stored".to_owned()
                    } else {
                        row.stored_match_status.clone()
                    }),
                ),
                (
                    "reviewBucket",
                    Value::String(if row.review_bucket.is_empty() {
                        if row.stored_cardmarket_url.is_empty() {
                            "candidate_review".to_owned()
                        } else {
                            "verified_audit".to_owned()
                        }
                    } else {
                        row.review_bucket.clone()
                    }),
                ),
            ])
        })
        .collect();

    http::json_with(
        StatusCode::OK,
        json!({
            "rows": payload,
            "user": user.to_json(),
            "generatedAt": super::now_iso(),
        }),
        &[("cache-control", "no-store")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_limit_null_is_zero_like_number_null() {
        assert_eq!(clean_limit(Some("250")), 250);
        assert_eq!(clean_limit(Some("abc")), 1000);
        assert_eq!(clean_limit(Some("0")), 1);
        assert_eq!(clean_limit(Some("-3")), 1);
        assert_eq!(clean_limit(Some("5000")), 1000);
        assert_eq!(clean_limit(None), 1, "Number(null) is 0");
        assert_eq!(clean_limit(Some("")), 1, "Number('') is 0");
    }

    #[test]
    fn clean_locale_two_letter_only() {
        assert_eq!(clean_locale(None), "en");
        assert_eq!(clean_locale(Some("IT")), "it");
        assert_eq!(clean_locale(Some("jpn")), "en");
        assert_eq!(clean_locale(Some("de")), "de");
    }

    #[test]
    fn clean_cardmarket_url_gates_https_host_and_path() {
        assert_eq!(
            clean_cardmarket_url(&json!(
                "https://www.cardmarket.com/en/Pokemon/Products/Singles/BREAKthrough/Ralts-BKT100#x"
            )),
            "https://www.cardmarket.com/en/Pokemon/Products/Singles/BREAKthrough/Ralts-BKT100"
        );
        assert_eq!(
            clean_cardmarket_url(&json!(
                "http://www.cardmarket.com/en/Pokemon/Products/Singles/X"
            )),
            ""
        );
        assert_eq!(
            clean_cardmarket_url(&json!("https://example.com/en/Pokemon/Products/Singles/X")),
            ""
        );
        assert_eq!(
            clean_cardmarket_url(&json!(
                "https://www.cardmarket.com/en/Magic/Products/Singles/X"
            )),
            ""
        );
        assert_eq!(clean_cardmarket_url(&json!("not a url")), "");
        assert_eq!(clean_cardmarket_url(&json!(null)), "");
    }

    #[test]
    fn clean_string_array_caps_at_twelve() {
        assert_eq!(clean_string_array(&json!([" a ", ""])), vec!["a"]);
        assert_eq!(
            clean_string_array(&json!("not-array")),
            Vec::<String>::new()
        );
        let many: Vec<String> = (0..20).map(|i| i.to_string()).collect();
        assert_eq!(clean_string_array(&json!(many)).len(), 12);
    }
}
