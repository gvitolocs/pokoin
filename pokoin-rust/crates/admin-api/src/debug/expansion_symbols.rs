//! Port of `api/marketplace-expansion-symbols.js` — read or update the
//! `public.pokoin_pokemon_expansions` symbol/logo metadata behind the
//! search-debug gate.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
};
use serde_json::{json, Value};
use sqlx::Row;

use pokoin_api_common::{http, RouteState};

use super::{
    clean_text_value, db_error, json_object, request_query, truncate_utf16, value_get, HandlerError,
};
use unicode_normalization::UnicodeNormalization;

/// `slugify(value)` of this handler (lowercase, `&` -> ` and `, 140 chars).
pub(crate) fn slugify(value: &str) -> String {
    let base: String = value
        .nfkd()
        .filter(|ch| !('\u{0300}'..='\u{036f}').contains(ch))
        .collect();
    // `.replace(/&/g, ' and ')` first, then collapse every non `[a-z0-9]`
    // run into one dash, in that order.
    let with_and = base.to_lowercase().replace('&', " and ");
    let mut out = String::new();
    let mut last_was_separator = false;
    for ch in with_and.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_was_separator = false;
        } else if !last_was_separator {
            out.push('-');
            last_was_separator = true;
        }
    }
    let trimmed = out.trim_matches('-').to_owned();
    truncate_utf16(&trimmed, 140)
}

/// `defaultSymbolUrl(name)`.
pub(crate) fn default_symbol_url(name: &str) -> String {
    let slug = slugify(name);
    if slug.is_empty() {
        String::new()
    } else {
        format!("https://cdn.pokoin.com/expansions/symbols/{slug}.png")
    }
}

/// `defaultLogoUrl(name)`.
pub(crate) fn default_logo_url(name: &str) -> String {
    let slug = slugify(name);
    if slug.is_empty() {
        String::new()
    } else {
        format!("https://cdn.pokoin.com/expansions/logos/{slug}.png")
    }
}

/// `objectKeyFromCdnUrl(value, prefix)`.
pub(crate) fn object_key_from_cdn_url(value: &Value, prefix: &str) -> Option<String> {
    let url = clean_text_value(value, 500);
    let marker = format!("/{prefix}/");
    url.split_once(&marker)
        .map(|(_, rest)| format!("{prefix}/{rest}"))
}

/// `isValidHttpUrl(value)`.
pub(crate) fn is_valid_http_url(value: &str) -> bool {
    match reqwest::Url::parse(value) {
        Ok(url) => url.scheme() == "https" || url.scheme() == "http",
        Err(_) => false,
    }
}

/// `cleanLimit(value, fallback = 300)` — missing param is `Number(null)` = 0.
pub(crate) fn clean_limit(value: Option<&str>, fallback: i64) -> i64 {
    let number = match value {
        None => Some(0.0),
        Some(text) => http::js_number(text),
    };
    match number {
        Some(limit) if limit.is_finite() => (limit.trunc() as i64).clamp(1, 1000),
        _ => fallback,
    }
}

/// `hashString(value)`: signed 32-bit `hash*31 + unit` over the UTF-16 code
/// units of every char (the JS loop reads `charCodeAt(0)` of each char).
pub(crate) fn hash_string(value: &str) -> i32 {
    let mut hash: i32 = 0;
    for ch in value.chars() {
        let mut buffer = [0u16; 2];
        let code = ch.encode_utf16(&mut buffer)[0] as i32;
        hash = hash.wrapping_mul(31).wrapping_add(code);
    }
    hash
}

/// `listExpansionSymbols({ query, missingOnly, missingLogoOnly, limit })`.
async fn list_expansion_symbols(
    state: &RouteState,
    query: &str,
    missing_only: &str,
    missing_logo_only: &str,
    limit: Option<&str>,
) -> Result<Value, HandlerError> {
    let normalized_query = clean_text_value(&Value::String(query.to_owned()), 240);
    let mut filters: Vec<String> =
        vec!["expansion_name is not null and expansion_name <> ''".to_owned()];
    if !normalized_query.is_empty() {
        filters.push("versions.expansion_name ilike ?".to_owned());
    }
    if missing_only.trim() == "1" {
        filters.push("coalesce(expansions.symbol_image_url, '') = ''".to_owned());
    }
    if missing_logo_only.trim() == "1" {
        filters.push("coalesce(expansions.logo_image_url, '') = ''".to_owned());
    }
    let limit_value = clean_limit(limit, 300);
    // `values` in the Node code only holds conditional binds (the optional
    // ilike) plus the limit, so the limit placeholder is `values.length` after
    // the push — `$1` when no query, `$2` with one.
    let limit_param = filters.iter().filter(|clause| clause.contains('?')).count() + 1;

    // Placeholder resolution (`$n` by push order).
    let mut placeholders = 0;
    let indexed: Vec<String> = filters
        .iter()
        .map(|clause| {
            if clause.contains('?') {
                placeholders += 1;
                clause.replace('?', &format!("${placeholders}"))
            } else {
                clause.clone()
            }
        })
        .collect();
    let sql_text = format!(
        r#"
      select
        versions.expansion_name as name,
        min(expansions.expansion_id) as expansion_id,
        min(expansions.code) as code,
        min(expansions.source_asset_code) as source_asset_code,
        min(expansions.symbol_image_url) as symbol_image_url,
        min(expansions.symbol_object_key) as symbol_object_key,
        min(expansions.logo_image_url) as logo_image_url,
        min(expansions.logo_object_key) as logo_object_key,
        count(*)::integer as card_count
      from public.marketplace_card_versions versions
      left join public.pokoin_pokemon_expansions expansions
        on expansions.name = versions.expansion_name
      where {}
      group by versions.expansion_name
      order by versions.expansion_name asc
      limit ${}
    "#,
        indexed.join(" and "),
        limit_param,
    );

    let mut statement = sqlx::query(&sql_text);
    if !normalized_query.is_empty() {
        statement = statement.bind(format!("%{normalized_query}%"));
    }
    statement = statement.bind(limit_value);
    let rows = statement
        .fetch_all(state.api.read())
        .await
        .map_err(db_error)?;

    let expansions: Vec<Value> = rows
        .iter()
        .map(|row| {
            let name: String = row
                .try_get::<Option<String>, _>("name")
                .unwrap_or_default()
                .unwrap_or_default();
            let expansion_id: Option<i32> = row.try_get("expansion_id").unwrap_or(None);
            let text = |column: &str| -> String {
                row.try_get::<Option<String>, _>(column)
                    .unwrap_or_default()
                    .unwrap_or_default()
            };
            json_object(vec![
                ("name", Value::String(name.clone())),
                (
                    "expansionId",
                    match expansion_id {
                        Some(id) => json!(id),
                        None => Value::Null,
                    },
                ),
                ("code", Value::String(text("code"))),
                ("sourceAssetCode", Value::String(text("source_asset_code"))),
                ("symbolImageUrl", Value::String(text("symbol_image_url"))),
                ("symbolObjectKey", Value::String(text("symbol_object_key"))),
                ("logoImageUrl", Value::String(text("logo_image_url"))),
                ("logoObjectKey", Value::String(text("logo_object_key"))),
                ("defaultSymbolUrl", Value::String(default_symbol_url(&name))),
                ("defaultLogoUrl", Value::String(default_logo_url(&name))),
                (
                    "cardCount",
                    json!(row
                        .try_get::<Option<i32>, _>("card_count")
                        .unwrap_or(None)
                        .unwrap_or(0)),
                ),
            ])
        })
        .collect();
    Ok(json!({ "expansions": expansions }))
}

/// `updateExpansionSymbol({ name, symbolImageUrl, logoImageUrl, sourceAssetCode })`.
async fn update_expansion_symbol(state: &RouteState, body: &Value) -> Result<Value, HandlerError> {
    let expansion_name = clean_text_value(value_get(body, "name"), 240);
    let symbol_url = clean_text_value(value_get(body, "symbolImageUrl"), 500);
    let logo_url = clean_text_value(value_get(body, "logoImageUrl"), 500);
    let source_code = clean_text_value(value_get(body, "sourceAssetCode"), 120);
    if expansion_name.is_empty() {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Expansion name is required.",
        ));
    }
    if !symbol_url.is_empty() && !is_valid_http_url(&symbol_url) {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Symbol URL must be a valid http(s) URL.",
        ));
    }
    if !logo_url.is_empty() && !is_valid_http_url(&logo_url) {
        return Err(HandlerError::new(
            StatusCode::BAD_REQUEST,
            "Logo URL must be a valid http(s) URL.",
        ));
    }

    let version_row = sqlx::query(
        r#"
      select min(expansion_name) as name
      from public.marketplace_card_versions
      where expansion_name = $1
    "#,
    )
    .bind(&expansion_name)
    .fetch_one(state.api.read())
    .await
    .map_err(db_error)?;
    let found: Option<String> = version_row.try_get("name").unwrap_or(None);
    if found.as_deref().unwrap_or("").is_empty() {
        return Err(HandlerError::new(
            StatusCode::NOT_FOUND,
            "Expansion was not found in marketplace versions.",
        ));
    }

    let id_row = sqlx::query(
        r#"
      select expansion_id
      from public.pokoin_pokemon_expansions
      where name = $1
      limit 1
    "#,
    )
    .bind(&expansion_name)
    .fetch_optional(state.api.read())
    .await
    .map_err(db_error)?;
    let existing_id = id_row
        .and_then(|row| {
            row.try_get::<Option<i32>, _>("expansion_id")
                .unwrap_or(None)
        })
        .unwrap_or(0);
    let expansion_id = if existing_id > 0 {
        existing_id as i64
    } else {
        (hash_string(&expansion_name) as i64).abs() + 2_000_000_000
    };

    let symbol_object_key =
        object_key_from_cdn_url(&Value::String(symbol_url.clone()), "expansions/symbols");
    let logo_object_key =
        object_key_from_cdn_url(&Value::String(logo_url.clone()), "expansions/logos");

    let row = sqlx::query(
        r#"
      insert into public.pokoin_pokemon_expansions (
        expansion_id,
        game_id,
        name,
        source_asset_code,
        symbol_image_url,
        symbol_object_key,
        symbol_imported_at,
        logo_image_url,
        logo_object_key,
        logo_imported_at
      )
      values ($1, 5, $2, nullif($3, ''), nullif($4, ''), $5, now(), nullif($6, ''), $7, now())
      on conflict (expansion_id) do update set
        name = excluded.name,
        source_asset_code = excluded.source_asset_code,
        symbol_image_url = excluded.symbol_image_url,
        symbol_object_key = excluded.symbol_object_key,
        symbol_imported_at = now(),
        logo_image_url = excluded.logo_image_url,
        logo_object_key = excluded.logo_object_key,
        logo_imported_at = now()
      returning
        expansion_id,
        name,
        source_asset_code,
        symbol_image_url,
        symbol_object_key,
        logo_image_url,
        logo_object_key
    "#,
    )
    .bind(expansion_id)
    .bind(&expansion_name)
    .bind(&source_code)
    .bind(&symbol_url)
    .bind(&symbol_object_key)
    .bind(&logo_url)
    .bind(&logo_object_key)
    .fetch_one(state.api.read())
    .await
    .map_err(db_error)?;

    let text = |column: &str| -> String {
        row.try_get::<Option<String>, _>(column)
            .unwrap_or_default()
            .unwrap_or_default()
    };
    let name: String = row
        .try_get::<Option<String>, _>("name")
        .unwrap_or_default()
        .unwrap_or(expansion_name.clone());
    let returned_id: i32 = row
        .try_get::<Option<i32>, _>("expansion_id")
        .unwrap_or(None)
        .unwrap_or(expansion_id as i32);
    Ok(json_object(vec![
        ("name", Value::String(name)),
        ("expansionId", json!(returned_id)),
        ("sourceAssetCode", Value::String(text("source_asset_code"))),
        ("symbolImageUrl", Value::String(text("symbol_image_url"))),
        ("symbolObjectKey", Value::String(text("symbol_object_key"))),
        ("logoImageUrl", Value::String(text("logo_image_url"))),
        ("logoObjectKey", Value::String(text("logo_object_key"))),
        (
            "defaultSymbolUrl",
            Value::String(default_symbol_url(&expansion_name)),
        ),
        (
            "defaultLogoUrl",
            Value::String(default_logo_url(&expansion_name)),
        ),
    ]))
}

pub(crate) async fn handle(
    State(state): State<RouteState>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    // The Node handler authorizes before the method check, so unsupported
    // methods still answer 401/403 for unauthenticated callers.
    if let Err(error) = state.require_debug_admin(&headers).await {
        return error;
    }
    if method == Method::GET {
        let query = request_query(&uri);
        return match list_expansion_symbols(
            &state,
            &query.text("query"),
            &query.text("missingOnly"),
            &query.text("missingLogoOnly"),
            query.first("limit"),
        )
        .await
        {
            Ok(payload) => http::json_with(
                StatusCode::OK,
                payload,
                &[("cache-control", "private, no-store")],
            ),
            Err(error) => error.into_response_with(&[]),
        };
    }
    if method == Method::POST {
        let parsed = match http::parse_body(&headers, &body) {
            Ok(parsed) => parsed.json(),
            Err(error) => return error,
        };
        return match update_expansion_symbol(&state, &parsed).await {
            Ok(updated) => http::json(StatusCode::OK, json!({ "expansion": updated })),
            Err(error) => error.into_response_with(&[]),
        };
    }
    http::json_with(
        StatusCode::METHOD_NOT_ALLOWED,
        json!({ "error": "Method not allowed." }),
        &[("allow", "GET, POST")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_matches_node() {
        assert_eq!(slugify("Sword & Shield"), "sword-and-shield");
        assert_eq!(slugify("Pokémon"), "pokemon");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("Neo Discovery!"), "neo-discovery");
    }

    #[test]
    fn default_urls_use_the_cdn_slug() {
        assert_eq!(
            default_symbol_url("Call of Legends"),
            "https://cdn.pokoin.com/expansions/symbols/call-of-legends.png"
        );
        assert_eq!(default_logo_url(""), "");
        assert_eq!(default_symbol_url(""), "");
    }

    #[test]
    fn object_key_extracts_after_the_marker() {
        assert_eq!(
            object_key_from_cdn_url(
                &json!("https://cdn.pokoin.com/expansions/symbols/swsh.png"),
                "expansions/symbols"
            ),
            Some("expansions/symbols/swsh.png".to_owned())
        );
        assert_eq!(
            object_key_from_cdn_url(&json!("https://example.com/x.png"), "expansions/symbols"),
            None
        );
    }

    #[test]
    fn clean_limit_null_is_zero() {
        assert_eq!(clean_limit(Some("50"), 300), 50);
        assert_eq!(clean_limit(Some("abc"), 300), 300);
        assert_eq!(clean_limit(Some("0"), 300), 1);
        assert_eq!(clean_limit(Some("9999"), 300), 1000);
        assert_eq!(clean_limit(None, 300), 1, "Number(null) is 0");
    }

    #[test]
    fn hash_string_matches_the_js_31_bit_roll() {
        // Reference values computed with the Node hashString.
        assert_eq!(hash_string(""), 0);
        assert_eq!(hash_string("a"), 97);
        assert_eq!(hash_string("ab"), 97 * 31 + 98);
        assert_eq!(hash_string("Base Set"), {
            let mut h: i32 = 0;
            for b in "Base Set".chars() {
                h = h.wrapping_mul(31).wrapping_add(b as i32);
            }
            h
        });
    }

    #[test]
    fn http_url_gate() {
        assert!(is_valid_http_url("https://cdn.pokoin.com/x.png"));
        assert!(is_valid_http_url("http://cdn.pokoin.com/x.png"));
        assert!(!is_valid_http_url("ftp://cdn.pokoin.com/x.png"));
        assert!(!is_valid_http_url("not a url"));
    }
}
