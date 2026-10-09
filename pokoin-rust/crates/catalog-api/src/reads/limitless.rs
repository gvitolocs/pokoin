//! `GET /api/limitless-expansion-blueprints` — port of `limitless-expansion-blueprints.js`.

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use serde_json::{json, Value};

use super::util;
use crate::shared::js;

fn clean_text(value: &str, max: usize) -> String {
    js::clean_text_str(value, max)
}

/// `normalizeCode(value)`.
pub fn normalize_code(value: &str) -> String {
    clean_text(value, 60).to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

fn or_default(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        Some(v) if js::truthy(Some(v)) => v.clone(),
        _ => fallback,
    }
}

pub async fn handler(State(state): State<RouteState>, method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return util::method_not_allowed("GET");
    }
    let q = http::Query::from_uri(&uri);
    let include_blueprints = q.search_param("includeBlueprints") == Some("1");
    let mut binds = vec![Bind::Bool(include_blueprints)];
    let mut where_clause = String::from("where 1=1");
    let expansion_key = clean_text(q.search_param("expansionKey").unwrap_or(""), 240);
    if !expansion_key.is_empty() {
        binds.push(Bind::Text(expansion_key));
        where_clause += &format!(" and expansions.expansion_key = ${}", binds.len());
    }
    let set_code = normalize_code(util::first_of(&q, &["setCode", "code"]).unwrap_or(""));
    if !set_code.is_empty() {
        binds.push(Bind::Text(set_code));
        let n = binds.len();
        where_clause += &format!(" and (
      regexp_replace(lower(expansions.pokoin_expansion_code), '[^a-z0-9]+', '', 'g') = ${n}
      or regexp_replace(lower(expansions.limitless_expansion_code), '[^a-z0-9]+', '', 'g') = ${n}
    )");
    }
    let name = clean_text(util::first_of(&q, &["name", "query"]).unwrap_or(""), 180);
    if !name.is_empty() {
        binds.push(Bind::Text(format!("%{name}%")));
        let n = binds.len();
        where_clause += &format!(" and (
      expansions.pokoin_expansion_name ilike ${n}
      or expansions.limitless_expansion_name ilike ${n}
    )");
    }
    binds.push(Bind::Int(util::js_limit(q.search_param("limit"), 1000, 5000)));
    let sql = format!(
        "
      select
        expansions.expansion_key,
        expansions.pokoin_expansion_name,
        expansions.pokoin_expansion_code,
        expansions.limitless_expansion_name,
        expansions.limitless_expansion_code,
        expansions.aliases,
        expansions.raw_metadata,
        expansions.source,
        expansions.source_url,
        expansions.source_updated_at,
        expansions.updated_at,
        count(mapping.blueprint_id)::integer as blueprint_count,
        case when $1::boolean then
          coalesce(jsonb_agg(
            jsonb_build_object(
              'blueprintId', mapping.blueprint_id::text,
              'cardId', mapping.card_id::text,
              'name', mapping.card_name,
              'collectorNumber', mapping.collector_number,
              'normalizedCollectorNumber', mapping.normalized_collector_number,
              'setCode', mapping.set_code,
              'limitlessCardKey', mapping.limitless_card_key,
              'limitlessCardName', mapping.limitless_card_name,
              'sourceCardId', mapping.source_card_id,
              'sourceUrl', mapping.source_url,
              'matchConfidence', mapping.match_confidence,
              'matchReason', mapping.match_reason
            )
            order by mapping.normalized_collector_number, mapping.card_name, mapping.blueprint_id
          ) filter (where mapping.blueprint_id is not null), '[]'::jsonb)
        else '[]'::jsonb end as blueprints
      from public.limitless_marketplace_expansions expansions
      left join public.limitless_marketplace_expansion_blueprints mapping
        on mapping.expansion_key = expansions.expansion_key
      {where_clause}
      group by expansions.expansion_key
      order by expansions.pokoin_expansion_name asc, expansions.limitless_expansion_name asc
      limit ${}
    ",
        binds.len()
    );
    match pg::pool_rows(state.api.read(), &sql, &binds).await {
        Ok(rows) => {
            let expansions: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "expansionKey": row["expansion_key"],
                        "pokoinExpansionName": row["pokoin_expansion_name"],
                        "pokoinExpansionCode": row["pokoin_expansion_code"],
                        "limitlessExpansionName": row["limitless_expansion_name"],
                        "limitlessExpansionCode": row["limitless_expansion_code"],
                        "aliases": or_default(row.get("aliases"), json!([])),
                        "blueprintCount": pg::js_number(js::number(row.get("blueprint_count")).max(0.0).min(f64::MAX)),
                        "blueprints": or_default(row.get("blueprints"), json!([])),
                        "rawMetadata": or_default(row.get("raw_metadata"), json!({})),
                        "source": row["source"],
                        "sourceUrl": row["source_url"],
                        "sourceUpdatedAt": row["source_updated_at"],
                        "updatedAt": row["updated_at"],
                    })
                })
                .collect();
            util::json_cache(StatusCode::OK, json!({ "expansions": expansions }), "public, max-age=60, s-maxage=300")
        }
        Err(error) => util::db_error("limitless-expansion-blueprints", &error, "Limitless expansion blueprints failed."),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn codes() {
        assert_eq!(super::normalize_code(" SV-1a "), "sv1a");
    }
}
