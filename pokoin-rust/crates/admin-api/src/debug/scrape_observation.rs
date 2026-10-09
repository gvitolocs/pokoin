//! Port of `api/cardmarket-scrape-observation.js` — unauthenticated (optional
//! user) recording of Cardmarket scrape observations with optional promotion
//! into `public.marketplace_cm_verified_links`.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Map, Value};
use sqlx::Row;

use pokoin_api_common::{http, RouteState};

use super::{db_error, iso_millis, json_object, truncate_utf16, HandlerError};

const CORS_HEADERS: [(&str, &str); 4] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "POST, OPTIONS"),
    (
        "access-control-allow-headers",
        "Content-Type, Authorization",
    ),
    ("access-control-max-age", "86400"),
];

/// `cleanText(value, maxLength)` of this handler: whitespace collapsed.
pub(crate) fn clean_text_collapse(value: &Value, max: usize) -> String {
    let text = super::js_truthy_string(value);
    let mut out = String::new();
    let mut last_was_space = false;
    for ch in text.trim().chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    super::truncate_utf16(&out, max)
}

/// `cleanLocale(value)`.
pub(crate) fn clean_locale(value: &Value) -> String {
    let locale = clean_text_collapse(value, 8).to_lowercase();
    if locale.len() == 2 && locale.bytes().all(|byte| byte.is_ascii_lowercase()) {
        locale
    } else {
        "en".to_owned()
    }
}

/// `cleanCardmarketUrl(value)` — returns the normalized URL text.
pub(crate) fn clean_cardmarket_url(value: &Value) -> Option<reqwest::Url> {
    let text = clean_text_collapse(value, 800);
    let parsed = reqwest::Url::parse(&text).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str().unwrap_or_default();
    if host != "www.cardmarket.com" && host != "cardmarket.com" {
        return None;
    }
    if !parsed.path().contains("/Pokemon/Products/Singles/") {
        return None;
    }
    let mut parsed = parsed;
    parsed.set_fragment(None);
    Some(parsed)
}

/// `cardmarketPathParts(parsedUrl)`.
pub(crate) fn cardmarket_path_parts(parsed_url: &reqwest::Url) -> (String, String, String) {
    let parts: Vec<String> = parsed_url
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            urlencoding::decode(part)
                .map(|value| value.to_string())
                .unwrap_or_else(|_| part.to_owned())
        })
        .collect();
    let singles_index = parts
        .iter()
        .position(|part| part.to_lowercase() == "singles");
    let locale = parts.first().map(|part| part.as_str()).unwrap_or("");
    let expansion_slug = singles_index
        .and_then(|index| parts.get(index + 1))
        .map(|part| clean_text_collapse(&Value::String(part.clone()), 240))
        .unwrap_or_default();
    let product_slug = singles_index
        .and_then(|index| parts.get(index + 2))
        .map(|part| clean_text_collapse(&Value::String(part.clone()), 320))
        .unwrap_or_default();
    (
        clean_locale(&Value::String(locale.to_owned())),
        expansion_slug,
        product_slug,
    )
}

/// `cleanJson(value, maxBytes = 16_000)`.
pub(crate) fn clean_json(value: &Value, max_bytes: usize) -> Value {
    if !value.is_object() && !value.is_array() {
        return json!({});
    }
    let text = value.to_string();
    if text.len() <= max_bytes {
        return value.clone();
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!({
        "truncated": true,
        "sample": text[..end].to_owned(),
    })
}

/// `cleanNumber(value)`.
pub(crate) fn clean_number(value: &Value) -> Option<f64> {
    super::js_number_of(value).filter(|number| number.is_finite())
}

/// `cleanBlueprintId(value)` — `None` instead of the Node `null`.
pub(crate) fn clean_blueprint_id(value: &Value) -> Option<i64> {
    match super::js_number_of(value) {
        Some(id)
            if id.is_finite() && id.trunc() == id && id > 0.0 && id <= 9_007_199_254_740_991.0 =>
        {
            Some(id as i64)
        }
        _ => None,
    }
}

/// `optionalUser(req)` — verify only when a bearer header is present.
async fn optional_user(state: &RouteState, headers: &HeaderMap) -> (String, String) {
    if headers.get("authorization").is_none() {
        return (String::new(), String::new());
    }
    let Ok(claims) = state.require_user(headers).await else {
        return (String::new(), String::new());
    };
    (
        clean_text_collapse(&Value::String(claims.uid.clone()), 160),
        clean_text_collapse(&Value::String(claims.email.clone()), 240),
    )
}

/// `ensureObservationTable()` — the Node handler runs these guards through
/// `marketplaceQuery` (read pool).
async fn ensure_observation_table(state: &RouteState) -> Result<(), HandlerError> {
    for statement in [
        r#"
    create table if not exists public.marketplace_cm_scrape_observations (
      id uuid primary key default gen_random_uuid(),
      cardmarket_url text not null,
      cardmarket_locale text not null default 'en',
      cardmarket_expansion_slug text not null default '',
      cardmarket_product_slug text not null default '',
      page_title text not null default '',
      scraped_name text not null default '',
      scraped_expansion text not null default '',
      collector_number text not null default '',
      collector_prefix text not null default '',
      numeric_collector_number text not null default '',
      raw_title text not null default '',
      structured_payload jsonb not null default '{}'::jsonb,
      page_context jsonb not null default '{}'::jsonb,
      matched_blueprint_id bigint references public.cardtrader_pokemon_blueprints(id) on delete set null,
      match_confidence numeric,
      match_payload jsonb not null default '{}'::jsonb,
      source text not null default 'pokemon-card-extension',
      extension_version text not null default '',
      user_agent text not null default '',
      debug_uid text not null default '',
      debug_email text not null default '',
      status text not null default 'observed' check (
        status in ('observed', 'matched', 'verified', 'rejected')
      ),
      notes text not null default '',
      observed_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  "#,
        r#"
    create unique index if not exists marketplace_cm_scrape_observations_url_idx
      on public.marketplace_cm_scrape_observations (cardmarket_url)
  "#,
        r#"
    create index if not exists marketplace_cm_scrape_observations_status_idx
      on public.marketplace_cm_scrape_observations (status, observed_at desc)
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
            .map_err(|error| db_error(error))?;
    }
    Ok(())
}

pub(crate) struct Observation {
    pub(crate) url: String,
    pub(crate) locale: String,
    pub(crate) expansion_slug: String,
    pub(crate) product_slug: String,
    pub(crate) page_title: String,
    pub(crate) scraped_name: String,
    pub(crate) scraped_expansion: String,
    pub(crate) collector_number: String,
    pub(crate) collector_prefix: String,
    pub(crate) numeric_collector_number: String,
    pub(crate) raw_title: String,
    pub(crate) structured_payload: Value,
    pub(crate) page_context: Value,
    pub(crate) matched_blueprint_id: Option<i64>,
    pub(crate) match_confidence: Option<f64>,
    pub(crate) match_payload: Value,
    pub(crate) source: String,
    pub(crate) extension_version: String,
    pub(crate) user_agent: String,
    pub(crate) debug_uid: String,
    pub(crate) debug_email: String,
    pub(crate) status: &'static str,
    pub(crate) promote_verified_link: bool,
    pub(crate) notes: String,
}

/// `observationFromBody(body, req, user)`.
pub(crate) fn observation_from_body(
    body: &Value,
    user_agent: &str,
    user: &(String, String),
) -> Result<Observation, HandlerError> {
    let parsed_url = clean_cardmarket_url(
        first_truthy(&[
            super::value_get(body, "cardmarketUrl"),
            super::value_get(body, "url"),
            super::value_get(body, "pageUrl"),
        ])
        .unwrap_or(&Value::Null),
    )
    .ok_or_else(|| {
        HandlerError::new(
            StatusCode::BAD_REQUEST,
            "A valid Cardmarket singles URL is required.",
        )
    })?;
    let (path_locale, path_expansion_slug, path_product_slug) = cardmarket_path_parts(&parsed_url);
    let structured = first_truthy(&[
        super::value_get(body, "structuredCard"),
        super::value_get(body, "structured"),
    ])
    .cloned()
    .unwrap_or_else(|| json!({}));
    let context = first_truthy(&[
        super::value_get(body, "cardmarketContext"),
        super::value_get(body, "context"),
    ])
    .cloned()
    .unwrap_or_else(|| json!({}));
    let match_value = first_truthy(&[
        super::value_get(body, "match"),
        super::value_get(body, "bestMatch"),
    ])
    .cloned()
    .unwrap_or_else(|| json!({}));
    let matched_blueprint_id = clean_blueprint_id(
        first_truthy(&[
            super::value_get(body, "blueprintId"),
            super::value_get(body, "matchedBlueprintId"),
            super::value_get(&match_value, "cardId"),
            super::value_get(&match_value, "blueprintId"),
        ])
        .unwrap_or(&Value::Null),
    );
    let match_confidence = clean_number(
        first_truthy(&[
            super::value_get(body, "matchConfidence"),
            super::value_get(&match_value, "relevanceScore"),
            super::value_get(&match_value, "score"),
        ])
        .unwrap_or(&Value::Null),
    );
    let promote_raw = super::value_get(body, "promoteVerifiedLink");
    let promote_verified_link = promote_raw.as_bool() == Some(true)
        || promote_raw.as_str() == Some("1")
        || promote_raw.as_str() == Some("true");

    // page_context: {...context, debug: body.debug, hostname: body.hostname}
    // — JSON.stringify drops undefined values, so absent body keys are not
    // written into the merged object.
    let mut page_context = match &context {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for key in ["debug", "hostname"] {
        if let Some(value) = body.get(key) {
            page_context.insert(key.to_owned(), value.clone());
        } else {
            page_context.shift_remove(key);
        }
    }

    Ok(Observation {
        url: parsed_url.as_str().to_owned(),
        locale: clean_locale(
            super::first_truthy(&[
                super::value_get(body, "locale"),
                &Value::String(path_locale),
            ])
            .unwrap_or(&Value::Null),
        ),
        expansion_slug: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(body, "cardmarketExpansionSlug"),
                &Value::String(path_expansion_slug),
            ])
            .unwrap_or(&Value::Null),
            240,
        ),
        product_slug: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(body, "cardmarketProductSlug"),
                &Value::String(path_product_slug),
            ])
            .unwrap_or(&Value::Null),
            320,
        ),
        page_title: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(body, "title"),
                super::value_get(body, "pageTitle"),
            ])
            .unwrap_or(&Value::Null),
            400,
        ),
        scraped_name: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(&structured, "name"),
                super::value_get(body, "name"),
                super::value_get(body, "cardName"),
            ])
            .unwrap_or(&Value::Null),
            240,
        ),
        scraped_expansion: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(&structured, "expansion"),
                super::value_get(&context, "expansion"),
                super::value_get(body, "expansionName"),
            ])
            .unwrap_or(&Value::Null),
            240,
        ),
        collector_number: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(&structured, "collectorNumber"),
                super::value_get(&structured, "printedCollectorNumber"),
                super::value_get(body, "collectorNumber"),
            ])
            .unwrap_or(&Value::Null),
            80,
        ),
        collector_prefix: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(&structured, "collectorNumberPrefix"),
                super::value_get(body, "collectorPrefix"),
            ])
            .unwrap_or(&Value::Null),
            40,
        ),
        numeric_collector_number: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(&structured, "numericCollectorNumber"),
                super::value_get(body, "numericCollectorNumber"),
            ])
            .unwrap_or(&Value::Null),
            40,
        ),
        raw_title: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(&structured, "rawTitle"),
                super::value_get(body, "rawTitle"),
                super::value_get(body, "title"),
            ])
            .unwrap_or(&Value::Null),
            500,
        ),
        structured_payload: clean_json(&structured, 16_000),
        page_context: clean_json(&Value::Object(page_context), 16_000),
        matched_blueprint_id,
        match_confidence,
        match_payload: clean_json(&match_value, 16_000),
        source: {
            let text = clean_text_collapse(
                super::first_truthy(&[
                    super::value_get(body, "source"),
                    &Value::String("pokemon-card-extension".to_owned()),
                ])
                .unwrap_or(&Value::Null),
                80,
            );
            text
        },
        extension_version: clean_text_collapse(
            super::first_truthy(&[
                super::value_get(body, "extensionVersion"),
                super::value_get(body, "version"),
            ])
            .unwrap_or(&Value::Null),
            40,
        ),
        user_agent: truncate_utf16(user_agent.trim(), 500),
        debug_uid: user.0.clone(),
        debug_email: user.1.clone(),
        status: if matched_blueprint_id.is_some() {
            "matched"
        } else {
            "observed"
        },
        promote_verified_link,
        notes: clean_text_collapse(super::value_get(body, "notes"), 500),
    })
}

/// JS truthiness helper shared with the module above.
#[allow(dead_code)]
fn first_truthy<'a>(values: &[&'a Value]) -> Option<&'a Value> {
    super::first_truthy(values)
}

const INSERT_OBSERVATION_SQL: &str = r#"
      insert into public.marketplace_cm_scrape_observations (
        cardmarket_url,
        cardmarket_locale,
        cardmarket_expansion_slug,
        cardmarket_product_slug,
        page_title,
        scraped_name,
        scraped_expansion,
        collector_number,
        collector_prefix,
        numeric_collector_number,
        raw_title,
        structured_payload,
        page_context,
        matched_blueprint_id,
        match_confidence,
        match_payload,
        source,
        extension_version,
        user_agent,
        debug_uid,
        debug_email,
        status,
        notes
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12::jsonb, $13::jsonb, $14, $15, $16::jsonb,
        $17, $18, $19, $20, $21, $22, $23
      )
      on conflict (cardmarket_url)
      do update set
        cardmarket_locale = excluded.cardmarket_locale,
        cardmarket_expansion_slug = excluded.cardmarket_expansion_slug,
        cardmarket_product_slug = excluded.cardmarket_product_slug,
        page_title = excluded.page_title,
        scraped_name = excluded.scraped_name,
        scraped_expansion = excluded.scraped_expansion,
        collector_number = excluded.collector_number,
        collector_prefix = excluded.collector_prefix,
        numeric_collector_number = excluded.numeric_collector_number,
        raw_title = excluded.raw_title,
        structured_payload = excluded.structured_payload,
        page_context = excluded.page_context,
        matched_blueprint_id = excluded.matched_blueprint_id,
        match_confidence = excluded.match_confidence,
        match_payload = excluded.match_payload,
        source = excluded.source,
        extension_version = excluded.extension_version,
        user_agent = excluded.user_agent,
        debug_uid = excluded.debug_uid,
        debug_email = excluded.debug_email,
        status = case
          when public.marketplace_cm_scrape_observations.status = 'verified'
            then public.marketplace_cm_scrape_observations.status
          else excluded.status
        end,
        notes = excluded.notes,
        observed_at = now(),
        updated_at = now()
      returning id, status, observed_at
    "#;

/// `saveObservation(observation)`.
async fn save_observation(
    state: &RouteState,
    observation: &Observation,
) -> Result<Value, HandlerError> {
    ensure_observation_table(state).await?;
    let row = sqlx::query(INSERT_OBSERVATION_SQL)
        .bind(&observation.url)
        .bind(&observation.locale)
        .bind(&observation.expansion_slug)
        .bind(&observation.product_slug)
        .bind(&observation.page_title)
        .bind(&observation.scraped_name)
        .bind(&observation.scraped_expansion)
        .bind(&observation.collector_number)
        .bind(&observation.collector_prefix)
        .bind(&observation.numeric_collector_number)
        .bind(&observation.raw_title)
        .bind(observation.structured_payload.to_string())
        .bind(observation.page_context.to_string())
        .bind(observation.matched_blueprint_id)
        .bind(observation.match_confidence)
        .bind(observation.match_payload.to_string())
        .bind(&observation.source)
        .bind(&observation.extension_version)
        .bind(&observation.user_agent)
        .bind(&observation.debug_uid)
        .bind(&observation.debug_email)
        .bind(observation.status)
        .bind(&observation.notes)
        .fetch_one(state.api.read())
        .await
        .map_err(db_error)?;
    let observed_at: Option<chrono::DateTime<chrono::Utc>> =
        row.try_get("observed_at").unwrap_or(None);
    Ok(json_object(vec![
        (
            "id",
            Value::String(
                row.try_get::<Option<String>, _>("id")
                    .unwrap_or_default()
                    .unwrap_or_default(),
            ),
        ),
        (
            "status",
            Value::String(
                row.try_get::<Option<String>, _>("status")
                    .unwrap_or_default()
                    .unwrap_or_default(),
            ),
        ),
        ("observed_at", iso_millis(&observed_at)),
    ]))
}

/// `promoteVerifiedLink(observation, savedObservation)`.
async fn promote_verified_link(
    state: &RouteState,
    observation: &Observation,
    saved: &Value,
) -> Result<Option<Value>, HandlerError> {
    if !observation.promote_verified_link {
        return Ok(None);
    }
    let Some(blueprint_id) = observation.matched_blueprint_id else {
        return Ok(None);
    };
    let result = sqlx::query(
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
      values ($1, $2, $3, $4, $5, $6, $7, 'cardmarket-scrape-observation', 'verified', $8, now())
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
      returning blueprint_id, cardmarket_locale, cardmarket_url
    "#,
    )
    .bind(blueprint_id)
    .bind(&observation.locale)
    .bind(&observation.url)
    .bind(&observation.product_slug)
    .bind(&observation.scraped_name)
    .bind(&observation.scraped_expansion)
    .bind(&observation.collector_number)
    .bind(format!(
        "Promoted from scrape observation {}.",
        super::value_get(saved, "id").as_str().unwrap_or("")
    ))
    .fetch_one(state.api.read())
    .await
    .map_err(db_error)?;
    sqlx::query(
        r#"
      update public.marketplace_cm_scrape_observations
      set status = 'verified',
          notes = concat_ws(E'\n', nullif(notes, ''), 'Promoted to verified links.'),
          updated_at = now()
      where id = $1::uuid
    "#,
    )
    .bind(super::value_get(saved, "id").as_str().unwrap_or(""))
    .execute(state.api.read())
    .await
    .map_err(db_error)?;
    let text = |column: &str| -> String {
        result
            .try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    Ok(Some(json!({
        "blueprint_id": result
            .try_get::<Option<i64>, _>("blueprint_id")
            .unwrap_or(None)
            .map(|id| id.to_string())
            .unwrap_or_default(),
        "cardmarket_locale": text("cardmarket_locale"),
        "cardmarket_url": text("cardmarket_url"),
    })))
}

fn cors_json(status: StatusCode, body: Value, extra: &[(&str, &str)]) -> Response {
    let mut headers: Vec<(&str, &str)> = CORS_HEADERS.to_vec();
    headers.extend_from_slice(extra);
    http::json_with(status, body, &headers)
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let _ = uri;
    if method == Method::OPTIONS {
        return super::empty_response(StatusCode::NO_CONTENT, &CORS_HEADERS);
    }
    if method != Method::POST {
        return cors_json(
            StatusCode::METHOD_NOT_ALLOWED,
            json!({ "error": "Method not allowed." }),
            &[("allow", "POST, OPTIONS")],
        );
    }

    let user = optional_user(&state, &headers).await;
    let parsed = match http::parse_body(&headers, &body) {
        Ok(parsed) => parsed.json(),
        Err(error) => return error,
    };
    let user_agent = headers
        .get("user-agent")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let observation = match observation_from_body(&parsed, &user_agent, &user) {
        Ok(observation) => observation,
        Err(error) => return error.into_response_with(&CORS_HEADERS),
    };
    let saved = match save_observation(&state, &observation).await {
        Ok(saved) => saved,
        Err(error) => {
            tracing::error!(message = %error.message(), "cardmarket-scrape-observation failed");
            return error.into_response_with(&CORS_HEADERS);
        }
    };
    let verified_link = match promote_verified_link(&state, &observation, &saved).await {
        Ok(link) => link,
        Err(error) => return error.into_response_with(&CORS_HEADERS),
    };
    cors_json(
        StatusCode::CREATED,
        json!({ "ok": true, "observation": saved, "verifiedLink": verified_link }),
        &[("cache-control", "no-store")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_text_collapses_whitespace() {
        assert_eq!(
            clean_text_collapse(&json!("  hello\t world \n"), 100),
            "hello world"
        );
        assert_eq!(clean_text_collapse(&json!(null), 10), "");
        assert_eq!(clean_text_collapse(&json!("abcdefghij"), 4), "abcd");
    }

    #[test]
    fn clean_cardmarket_url_validates() {
        let url = clean_cardmarket_url(&json!(
            "https://www.cardmarket.com/en/Pokemon/Products/Singles/BREAKthrough/Ralts-BKT100#frag"
        ))
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://www.cardmarket.com/en/Pokemon/Products/Singles/BREAKthrough/Ralts-BKT100"
        );
        assert!(clean_cardmarket_url(&json!(
            "http://www.cardmarket.com/en/Pokemon/Products/Singles/X"
        ))
        .is_none());
        assert!(
            clean_cardmarket_url(&json!("https://example.com/en/Pokemon/Products/Singles/X"))
                .is_none()
        );
        assert!(clean_cardmarket_url(&json!(
            "https://www.cardmarket.com/en/Magic/Products/Singles/X"
        ))
        .is_none());
        assert!(clean_cardmarket_url(&json!("junk")).is_none());
    }

    #[test]
    fn path_parts_decode_and_slice() {
        let url = reqwest::Url::parse(
            "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Kabutops-NDI25",
        )
        .unwrap();
        let (locale, expansion, product) = cardmarket_path_parts(&url);
        assert_eq!(locale, "en");
        assert_eq!(expansion, "Neo-Discovery");
        assert_eq!(product, "Kabutops-NDI25");
    }

    #[test]
    fn observation_requires_a_cardmarket_url() {
        let error = observation_from_body(
            &json!({ "cardmarketUrl": "https://example.com/x" }),
            "ua",
            &(String::new(), String::new()),
        )
        .err()
        .unwrap();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            error.body["error"],
            "A valid Cardmarket singles URL is required."
        );
    }

    #[test]
    fn observation_maps_body_fields() {
        let body = json!({
            "cardmarketUrl": "https://www.cardmarket.com/en/Pokemon/Products/Singles/Neo-Discovery/Kabutops-NDI25",
            "title": "Kabutops  NDI25  Cardmarket",
            "structured": {
                "name": "Kabutops",
                "collectorNumber": "  25/75  ",
                "rawTitle": "x",
                "password": "secret",
            },
            "context": {"expansion": "Neo Discovery"},
            "match": {"blueprintId": "123536", "score": "0.97"},
            "blueprintId": 0,
            "promoteVerifiedLink": "true",
            "notes": "observed in the wild",
        });
        let observation =
            observation_from_body(&body, "  agent/1 ", &(String::new(), String::new())).unwrap();
        assert_eq!(observation.locale, "en");
        assert_eq!(observation.expansion_slug, "Neo-Discovery");
        assert_eq!(observation.product_slug, "Kabutops-NDI25");
        assert_eq!(observation.page_title, "Kabutops NDI25 Cardmarket");
        assert_eq!(observation.scraped_name, "Kabutops");
        assert_eq!(observation.scraped_expansion, "Neo Discovery");
        assert_eq!(observation.collector_number, "25/75");
        assert_eq!(observation.matched_blueprint_id, Some(123536));
        assert_eq!(observation.match_confidence, Some(0.97));
        assert_eq!(observation.status, "matched");
        assert!(observation.promote_verified_link);
        // `structuredPayload: cleanJson(structured)` keeps every key — the
        // secret-key stripping only happens in flutter-debug-logs sanitizeValue.
        assert_eq!(
            observation.structured_payload.get("password"),
            Some(&json!("secret"))
        );
        assert_eq!(observation.user_agent, "agent/1");
        assert_eq!(observation.source, "pokemon-card-extension");

        let bare = observation_from_body(&json!({}), "ua", &(String::new(), String::new()));
        assert!(bare.is_err());
    }

    #[test]
    fn clean_json_truncates_oversized_payloads() {
        let big = json!({"blob": "x".repeat(20_000)});
        let clean = clean_json(&big, 16_000);
        assert_eq!(clean["truncated"], true);
        assert_eq!(clean["sample"].as_str().unwrap().len(), 16_000);
        let small = json!({"blob": "x".repeat(10)});
        assert_eq!(clean_json(&small, 16_000), small);
        assert_eq!(clean_json(&Value::Null, 100), json!({}));
    }
}
