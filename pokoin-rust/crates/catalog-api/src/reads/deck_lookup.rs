//! `GET|POST|OPTIONS /api/deck-card-version-lookup` — port of `deck-card-version-lookup.js`.

use std::cmp::Ordering;
use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use super::util;
use crate::shared::{card_emoji, card_rarity, card_versions, js};

const CORS: [(&str, &str); 3] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET,POST,OPTIONS"),
    ("access-control-allow-headers", "Content-Type"),
];

fn clean_text(value: &str, max: usize) -> String {
    js::clean_text_str(value, max)
}

/// `compactText(value)`.
pub fn compact_text(value: &str) -> String {
    clean_text(value, 240)
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .collect::<String>()
        .to_lowercase()
        .replace(['’', '\''], "")
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

/// `normalizeCollectorNumber(value)` (lookahead via fancy-regex, like the JS regex).
pub fn normalize_collector_number(value: &str) -> String {
    static R: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let text = clean_text(value, 80).to_lowercase();
    let re = R.get_or_init(|| fancy_regex::Regex::new(r"[a-z]*0*([0-9]+[a-z]?)(?=\s*(?:/|$)|[^a-z0-9])").expect("regex"));
    if let Ok(Some(c)) = re.captures(&text) {
        if let Some(m) = c.get(1) {
            return m.as_str().to_owned();
        }
    }
    text.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

pub fn normalize_set_code(value: &str) -> String {
    clean_text(value, 40).to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

#[derive(Clone, Debug)]
pub struct Input {
    name: String,
    set_code: String,
    collector_number: String,
    limitless_expansion_name: String,
    limitless_expansion_code: String,
    language: String,
    limit: i64,
}

impl Input {
    fn to_json(&self) -> Value {
        json!({
            "name": self.name, "setCode": self.set_code, "collectorNumber": self.collector_number,
            "limitlessExpansionName": self.limitless_expansion_name, "limitlessExpansionCode": self.limitless_expansion_code,
            "language": self.language, "limit": self.limit,
        })
    }
}

/// `body[key] ?? url.searchParams.get(key)` stringified.
fn getter<'a>(body: &'a Value, q: &'a http::Query) -> impl Fn(&str) -> Option<Value> + 'a {
    move |key: &str| match body.get(key) {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => q.search_param(key).map(|s| Value::String(s.to_owned())),
    }
}

fn text_of(v: Option<Value>) -> String {
    js::string_or_empty(v.as_ref())
}

fn request_input(method: &Method, body: &Value, q: &http::Query) -> Input {
    let empty = json!({});
    let body = if *method == Method::POST && body.is_object() { body } else { &empty };
    let get = getter(body, q);
    let pick = |a: &str, b: &str| get(a).or_else(|| get(b));
    let language = clean_text(&text_of(pick("language", "lang")), 12);
    let limit_raw = get("limit");
    let limit = match &limit_raw {
        None => util::js_limit(None, 24, 100),
        Some(Value::String(s)) => util::js_limit(Some(s), 24, 100),
        Some(v) => {
            let n = js::number(Some(v));
            if n.is_finite() { (n.trunc() as i64).clamp(1, 100) } else { 24 }
        }
    };
    Input {
        name: clean_text(&text_of(get("name")), 160),
        set_code: clean_text(&text_of(pick("setCode", "set_code")), 160),
        collector_number: clean_text(&text_of(pick("collectorNumber", "collector_number")), 160),
        limitless_expansion_name: clean_text(&text_of(pick("limitlessExpansionName", "limitless_expansion_name")), 160),
        limitless_expansion_code: clean_text(&text_of(pick("limitlessExpansionCode", "limitless_expansion_code")), 160),
        language: if language.is_empty() { "en".into() } else { language },
        limit,
    }
}

/// `String.prototype.localeCompare` with `{ numeric: true, sensitivity: 'base' }`.
fn natural_compare(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut l = String::new();
                while let Some(c) = x.peek().copied().filter(char::is_ascii_digit) {
                    l.push(c);
                    x.next();
                }
                let mut r = String::new();
                while let Some(d) = y.peek().copied().filter(char::is_ascii_digit) {
                    r.push(d);
                    y.next();
                }
                let (lt, rt) = (l.trim_start_matches('0'), r.trim_start_matches('0'));
                let ord = lt.len().cmp(&rt.len()).then_with(|| lt.cmp(rt));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                if c != d {
                    return c.cmp(&d);
                }
                x.next();
                y.next();
            }
        }
    }
}

/// `rankDeckVersionRows(rows, input)`.
pub fn rank_deck_version_rows(rows: Vec<Value>, input: &Input) -> Vec<Value> {
    let target_name = compact_text(&input.name);
    let target_set = normalize_set_code(if input.set_code.is_empty() { &input.limitless_expansion_code } else { &input.set_code });
    let target_number = normalize_collector_number(&input.collector_number);
    let target_expansion = compact_text(&input.limitless_expansion_name);
    let mut ranked: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let f = |k: &str| js::string_or_empty(row.get(k));
            let first = |ks: &[&str]| ks.iter().map(|k| f(k)).find(|v| !v.is_empty()).unwrap_or_default();
            let row_name = compact_text(&first(&["name", "canonical_name", "display_name"]));
            let row_number = normalize_collector_number(&first(&["expansion_number", "card_number"]));
            let row_set = normalize_set_code(&first(&["expansion_code", "limitless_expansion_code", "cardtrader_expansion_code", "set_code"]));
            let row_expansion = compact_text(&f("expansion_name"));
            let mut score = 0i64;
            if row_name == target_name {
                score += 10_000;
            } else if row_name.contains(&target_name) || target_name.contains(&row_name) {
                score += 1_200;
            }
            if !target_number.is_empty() && row_number == target_number {
                score += 4_000;
            }
            if !target_set.is_empty() && row_set == target_set {
                score += 3_500;
            }
            if !target_expansion.is_empty() && row_expansion == target_expansion {
                score += 2_500;
            }
            if row_name == target_name && !target_number.is_empty() && row_number == target_number {
                score += 1_500;
            }
            if !target_set.is_empty() && row_set == target_set && !target_number.is_empty() && row_number == target_number {
                score += 1_500;
            }
            if row.get("product_type").and_then(Value::as_str) == Some("card") {
                score += 100;
            }
            if (!target_set.is_empty() && row_set != target_set) || (!target_number.is_empty() && row_number != target_number) {
                score -= 2_000;
            }
            let name_match = if row_name == target_name { "exact" } else if row_name.contains(&target_name) { "contains" } else { "" };
            let mut out = row.clone();
            if let Some(map) = out.as_object_mut() {
                map.insert("match_score".into(), json!(score));
                map.insert(
                    "match".into(),
                    json!({
                        "name": name_match,
                        "setCode": if !target_set.is_empty() && row_set == target_set { "exact" } else { "" },
                        "collectorNumber": if !target_number.is_empty() && row_number == target_number { "exact" } else { "" },
                    }),
                );
            }
            out
        })
        .collect();
    ranked.sort_by(|a, b| {
        let score = pokoin_sort::cmp_f64_desc(js::number(a.get("match_score")), js::number(b.get("match_score")));
        score
            .then_with(|| js::string_or_empty(a.get("expansion_name")).to_lowercase().cmp(&js::string_or_empty(b.get("expansion_name")).to_lowercase()))
            .then_with(|| natural_compare(&js::string_or_empty(a.get("expansion_number")), &js::string_or_empty(b.get("expansion_number"))))
    });
    ranked
}

async fn deck_version_rows(state: &RouteState, input: &Input) -> Result<Vec<Value>, sqlx::Error> {
    if input.name.is_empty() && input.collector_number.is_empty() {
        return Ok(Vec::new());
    }
    let mut binds: Vec<Bind> = Vec::new();
    let number_sql = card_versions::projected_expansion_number_sql();
    let number_int_sql = card_versions::projected_expansion_number_int_sql(&number_sql);
    let rarity_sql = card_rarity::projected_rarity_sql_default("candidates.rarity", &number_sql);
    let compact_name = compact_text(&input.name);
    let target_number = normalize_collector_number(&input.collector_number);
    let mut where_clause = String::from(
        "
    where coalesce(versions.preview_image_url, versions.cdn_image_url, versions.image_url) is not null
      and versions.product_type = 'card'
  ",
    );
    if !compact_name.is_empty() {
        binds.push(Bind::Text(compact_name));
        let n = binds.len();
        where_clause += &format!(
            "
      and (
        regexp_replace(lower(coalesce(nullif(versions.canonical_name, ''), versions.name)), '[^a-z0-9]+', '', 'g') = ${n}
        or regexp_replace(lower(versions.name), '[^a-z0-9]+', '', 'g') like '%' || ${n} || '%'
        or ${n} like '%' || regexp_replace(lower(versions.name), '[^a-z0-9]+', '', 'g') || '%'
      )
    "
        );
    } else if !target_number.is_empty() {
        binds.push(Bind::Text(target_number));
        let n = binds.len();
        where_clause += &format!(
            "
      and regexp_replace(
        lower(coalesce(substring({number_sql} from '[A-Za-z]*0*([0-9]+[A-Za-z]?)'), {number_sql})),
        '[^a-z0-9]+',
        '',
        'g'
      ) = ${n}
    "
        );
    }
    binds.push(Bind::Int((input.limit * 6).max(80)));
    let sql = format!(
        "
      select
        versions.card_id, versions.name, versions.display_name, versions.canonical_name, versions.expansion_name,
        {number_sql} as expansion_number,
        {number_int_sql} as expansion_number_int,
        versions.product_variant, versions.blueprint_id, versions.image_url, versions.cdn_image_url, versions.preview_image_url,
        versions.homepage_image_url, versions.product_type, versions.trainer_name, versions.card_palette, versions.emoji,
        artist.artist, artist.illustrator,
        {rarity_sql} as rarity,
        candidates.card_type, urls.canonical_path, versions.projected_at,
        expansions.code as expansion_code,
        expansions.symbol_image_url as expansion_symbol_url,
        expansions.logo_image_url as expansion_logo_url,
        coalesce(price_summary.listed_quantity, 0) as listed_quantity,
        price_summary.lowest_ask_pkn as lowest_price_pkn
      from public.marketplace_card_versions versions
      left join public.marketplace_search_candidates candidates
        on candidates.card_id = versions.card_id
      left join public.marketplace_blueprint_price_summary price_summary
        on price_summary.blueprint_id = versions.card_id
      left join public.cardtrader_pokemon_blueprints blueprints
        on blueprints.id = versions.card_id
      left join public.marketplace_blueprint_tcg_metadata tcg_metadata
        on tcg_metadata.blueprint_id = versions.card_id
      left join lateral (
        select collector_number
        from public.marketplace_cm_verified_links link
        where link.blueprint_id = versions.card_id
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
        where parsing.blueprint_id = versions.card_id
          and nullif(parsing.collector_number, '') is not null
        order by parsing.verified_at desc nulls last, parsing.updated_at desc nulls last
        limit 1
      ) product_parsing on true
      left join lateral (
        select e.*
        from public.pokoin_pokemon_expansions e
        where e.name = versions.expansion_name
          or (blueprints.expansion_id is not null and e.expansion_id = blueprints.expansion_id)
        order by case when e.name = versions.expansion_name then 0 else 1 end
        limit 1
      ) expansions on true
      left join public.marketplace_blueprint_artists artist
        on artist.blueprint_id = versions.blueprint_id
      left join public.marketplace_card_urls urls
        on urls.card_id = versions.card_id
        and urls.language = 'en'
      {where_clause}
      order by versions.projected_at desc nulls last, versions.card_id desc
      limit ${}
    ",
        binds.len()
    );
    let rows = pg::pool_rows(state.api.read(), &sql, &binds).await?;
    let rows: Vec<Value> = rows.iter().map(card_emoji::with_card_emoji_fields).collect();
    let mut ranked = rank_deck_version_rows(rows, input);
    ranked.truncate(input.limit as usize);
    Ok(ranked)
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    if method == Method::OPTIONS {
        return http::raw(StatusCode::NO_CONTENT, "text/plain", axum::body::Body::empty(), &CORS);
    }
    if method != Method::GET && method != Method::POST {
        let mut h = CORS.to_vec();
        h.push(("allow", "GET,POST,OPTIONS"));
        return http::json_with(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "Method not allowed." }), &h);
    }
    let body = match http::parse_body(&headers, &body) {
        Ok(b) => b.json(),
        Err(response) => return response,
    };
    let q = http::Query::from_uri(&uri);
    let input = request_input(&method, &body, &q);
    match deck_version_rows(&state, &input).await {
        Ok(matches) => {
            let mut h = CORS.to_vec();
            h.push(("cache-control", "public, max-age=20, s-maxage=120"));
            http::json_with(StatusCode::OK, json!({ "ok": true, "source": "oracle_structured_deck_lookup", "input": input.to_json(), "matches": matches }), &h)
        }
        Err(error) => {
            tracing::error!(%error, "deck-card-version-lookup failed");
            let message = match &error {
                sqlx::Error::Database(db) => db.message().to_owned(),
                other => other.to_string(),
            };
            http::json_with(StatusCode::INTERNAL_SERVER_ERROR, json!({ "ok": false, "error": message }), &CORS)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizers() {
        assert_eq!(normalize_collector_number("SVP 044"), "44");
        assert_eq!(normalize_collector_number("125/197"), "125");
        assert_eq!(normalize_collector_number("TG05"), "5");
        assert_eq!(compact_text("Pokémon Catcher’s"), "pokemoncatchers");
        assert_eq!(normalize_set_code("sv-1"), "sv1");
        assert_eq!(natural_compare("9", "10"), Ordering::Less);
        assert_eq!(natural_compare("A10", "a9"), Ordering::Greater);
    }
}
