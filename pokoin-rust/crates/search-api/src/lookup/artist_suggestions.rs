//! `GET /api/marketplace-artist-suggestions` — port of `marketplace-artist-suggestions.js`.

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use pokoin_catalog_api::reads::util;
use pokoin_catalog_api::shared::{artist_display, js};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

pub fn normalize_artist_query(value: &str) -> String {
    let folded: String = js::clean_text_str(value, 180).nfkd().filter(|c| !('\u{0300}'..='\u{036f}').contains(c)).collect::<String>().to_lowercase();
    let spaced: String = folded.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { ' ' }).collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn escape_like(value: &str) -> String {
    value.chars().flat_map(|c| if matches!(c, '\\' | '%' | '_') { vec!['\\', c] } else { vec![c] }).collect()
}

fn fuzzy_like_pattern(value: &str) -> String {
    let compact: String = value.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
    if compact.is_empty() {
        return "%%".into();
    }
    format!("%{}%", compact.chars().map(|c| escape_like(&c.to_string())).collect::<Vec<_>>().join("%"))
}

const SQL: &str = r#"
      with artist_sources as (
        select
          normalized_artist,
          max(nullif(artist, '')) as artist,
          max(coalesce(artist_card_count, 0))::integer as artist_card_count,
          count(distinct blueprint_id)::integer as known_count,
          ''::text as profile_image_url
        from public.marketplace_blueprint_artists
        where normalized_artist <> ''
        group by normalized_artist
        union all
        select
          normalized_artist,
          max(nullif(display_name, '')) as artist,
          0::integer as artist_card_count,
          0::integer as known_count,
          max(coalesce(nullif(profile_image_cdn_url, ''), nullif(profile_image_url, ''))) as profile_image_url
        from public.marketplace_artist_profiles
        where normalized_artist <> ''
        group by normalized_artist
      ),
      merged as (
        select
          normalized_artist,
          (array_agg(
            artist
            order by
              case when known_count > 0 then 0 else 1 end,
              artist_card_count desc,
              artist asc
          ))[1] as artist,
          greatest(max(artist_card_count), sum(known_count))::integer as known_count,
          max(profile_image_url) as profile_image_url
        from artist_sources
        where coalesce(artist, '') <> ''
        group by normalized_artist
      ),
      searchable as (
        select
          *,
          lower(regexp_replace(coalesce(artist, ''), '[^a-z0-9]+', ' ', 'g')) as artist_key,
          lower(regexp_replace(coalesce(normalized_artist, ''), '[^a-z0-9]+', ' ', 'g')) as normalized_key,
          regexp_replace(lower(coalesce(artist, '')), '[^a-z0-9]+', '', 'g') as compact_artist_key,
          regexp_replace(lower(coalesce(normalized_artist, '')), '[^a-z0-9]+', '', 'g') as compact_normalized_key
        from merged
      )
      select normalized_artist, artist, known_count, profile_image_url
      from searchable
      where $1::text = ''
        or artist_key = $1::text
        or normalized_key = $1::text
        or artist_key like $2::text escape '\'
        or normalized_key like $2::text escape '\'
        or artist_key like $3::text escape '\'
        or normalized_key like $3::text escape '\'
        or artist_key like $4::text escape '\'
        or normalized_key like $4::text escape '\'
        or compact_artist_key like $5::text escape '\'
        or compact_normalized_key like $5::text escape '\'
        or compact_artist_key like $6::text escape '\'
        or compact_normalized_key like $6::text escape '\'
      order by
        case
          when artist_key = $1::text or normalized_key = $1::text then 0
          when artist_key like $2::text escape '\'
            or normalized_key like $2::text escape '\' then 1
          when artist_key like $3::text escape '\'
            or normalized_key like $3::text escape '\' then 2
          when artist_key like $4::text escape '\'
            or normalized_key like $4::text escape '\' then 3
          when compact_artist_key like $5::text escape '\'
            or compact_normalized_key like $5::text escape '\' then 4
          else 5
        end,
        known_count desc,
        artist asc
      limit $7::integer
    "#;

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let key = normalize_artist_query(util::first_of(&q, &["q", "query"]).unwrap_or(""));
    let escaped = escape_like(&key);
    let compact: String = key.chars().filter(|c| !c.is_whitespace()).collect();
    let limit = util::js_limit(q.search_param("limit"), 12, 50);
    let binds = vec![
        Bind::Text(key.clone()),
        Bind::Text(format!("{escaped}%")),
        Bind::Text(format!("% {escaped}%")),
        Bind::Text(format!("%{escaped}%")),
        Bind::Text(format!("%{}%", escape_like(&compact))),
        Bind::Text(fuzzy_like_pattern(&key)),
        Bind::Int(limit),
    ];
    match pg::pool_rows(state.api.read(), SQL, &binds).await {
        Ok(rows) => {
            let artists: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let normalized = js::string_or_empty(row.get("normalized_artist"));
                    let slug_source = [normalized.clone(), js::string_or_empty(row.get("artist"))].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
                    let count = pg::js_number(if js::truthy(row.get("known_count")) { js::number(row.get("known_count")) } else { 0.0 });
                    let image = js::string_or_empty(row.get("profile_image_url"));
                    json!({
                        "name": artist_display::display_name_for_artist(row.get("normalized_artist"), None, row.get("artist")),
                        "normalizedArtist": normalized,
                        "slug": artist_display::normalize_artist_slug(Some(&Value::String(slug_source))),
                        "knownCount": count,
                        "cardCount": count,
                        "imageUrl": image,
                        "profileImageUrl": image,
                    })
                })
                .filter(|a| !js::string_or_empty(a.get("name")).is_empty() && !js::string_or_empty(a.get("normalizedArtist")).is_empty())
                .collect();
            util::json_cache(StatusCode::OK, json!({ "artists": artists }), "public, max-age=20, s-maxage=120")
        }
        Err(error) => util::db_error("marketplace-artist-suggestions", &error, "Marketplace artist suggestions failed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        assert_eq!(normalize_artist_query("  Mitsuhiro  Arita! "), "mitsuhiro arita");
        assert_eq!(normalize_artist_query("Kagemaru Himeno"), "kagemaru himeno");
        assert_eq!(fuzzy_like_pattern("ar ita"), "%a%r%i%t%a%");
        assert_eq!(escape_like("50%_x"), "50\\%\\_x");
    }
}
