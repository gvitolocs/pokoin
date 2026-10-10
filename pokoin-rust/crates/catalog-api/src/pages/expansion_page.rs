//! `GET /api/marketplace-expansion-page` — port of
//! `marketplace-expansion-page.js`: expansion metadata plus paginated singles
//! for a set browse page.

use axum::extract::State;
use axum::http::Uri;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use pokoin_api_common::http::Query;
use pokoin_api_common::RouteState;
use serde_json::{json, Value};

use super::support;
use crate::shared::{card_versions, expansions, js, page_snapshot, react_card, react_sql};

/// `slugify(value)` of the reference handler (NFKD fold, `&` -> ` and `,
/// 140-unit cap).
pub fn slugify(value: &str) -> String {
    expansions::slugify(value)
}

/// Route handler (GET; OPTIONS is answered by the preflight route; anything
/// else by [`method_not_allowed`]).
pub async fn handler(
    method: Method,
    State(state): State<RouteState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    // The reference handler 405s anything that is not GET (axum routes HEAD
    // to the GET handler; the reference would 405 HEAD too).
    if method != Method::GET {
        return support::method_not_allowed_get_options().await;
    }
    support::timing_scope(
        "/api/marketplace-expansion-page",
        "GET",
        handle(state, headers, uri),
    )
    .await
}

async fn handle(state: RouteState, headers: HeaderMap, uri: Uri) -> Response {
    let q = Query::from_uri(&uri);
    // Opt-in compact encoding; the default representation is unchanged.
    let wanted = support::wanted(&headers, &q);
    let game = support::resolve_game(&headers, q.first("game"), q.first("marketplaceGame"));
    let is_pokemon = pokoin_api_common::game::is_pokemon_game(&game);
    let pool = match support::game_pool(&state, &game).await {
        Ok(pool) => pool,
        Err(response) => return response,
    };

    let search_param = |key: &str| q.search_param(key).map(|v| Value::String(v.to_string()));
    let expansion_name = js::clean_text(
        Some(js::or(
            search_param("expansionName").as_ref(),
            js::or(
                search_param("set").as_ref(),
                js::or(search_param("setName").as_ref(), &Value::Null),
            ),
        )),
        180,
    );
    let slug_raw = search_param("slug");
    let slug = js::clean_text(
        Some(js::or(
            slug_raw.as_ref(),
            &Value::String(if expansion_name.is_empty() {
                String::new()
            } else {
                slugify(&expansion_name)
            }),
        )),
        180,
    );
    let product_type_raw = js::clean_text(search_param("productType").as_ref(), 60);
    let product_type = if product_type_raw.is_empty() {
        "card".to_string()
    } else {
        product_type_raw
    };
    let limit = react_card::parse_limit(q.search_param("limit"), 200, 400);
    let offset = react_card::parse_offset(q.search_param("offset"));

    let live_only = headers.contains_key(page_snapshot::BUILD_HEADER);
    if slug.is_empty() && expansion_name.is_empty() {
        let expansions_limit = react_card::parse_limit(q.search_param("limit"), 500, 2000);
        if !live_only {
            if let Some(page) = page_snapshot::read(&pool, page_snapshot::SET_INDEX, "all", 0, expansions_limit, false).await {
                return support::prebuilt(wanted, index_bytes(&page.rows, &game, limit), None, SET_INDEX_CACHE);
            }
        }
        // `listExpansions`: satellite games list from their set counts, not
        // the Pokemon-only marketplace_card_versions table.
        let listed = if is_pokemon {
            expansions::rows_for_expansions(&pool, None, expansions_limit).await
        } else {
            react_sql::read_expansions_from_set_counts(&pool, expansions_limit).await
        };
        let expansions = match listed
        {
            Ok(expansions) => expansions,
            Err(error) => {
                return support::node_error_response(&error, "Marketplace expansion page failed.")
            }
        };
        return support::json_with_cache_control_c1(
            wanted,
            StatusCode::OK,
            no_slug_body(expansions, &game, limit),
            SET_INDEX_CACHE,
        );
    }

    // One set, singles: the prebuilt desk, cut to this page by Postgres.
    if product_type == "card" && !live_only {
        if let Some(key) = page_snapshot::clean_key(&slug) {
            if let Some(page) = page_snapshot::read(&pool, page_snapshot::SET, &key, offset, limit, false).await {
                if let Some(bytes) = set_bytes(&page, limit, offset) {
                    return support::prebuilt(wanted, bytes, None, SET_CACHE);
                }
            }
        }
    }

    let mut expansion = if !slug.is_empty() {
        // try/catch around readExpansionBySlug -> null on failure.
        react_sql::read_expansion_by_slug(&pool, is_pokemon, &slug)
            .await
            .unwrap_or(None)
    } else {
        None
    };
    if expansion.is_none() {
        let listed = match expansions::rows_for_expansions(&pool, Some(&slug), 1).await {
            Ok(listed) => listed,
            Err(error) => {
                return support::node_error_response(&error, "Marketplace expansion page failed.")
            }
        };
        expansion = listed.into_iter().next();
    }
    if expansion.is_none() && !expansion_name.is_empty() {
        expansion = Some(json!({
            "name": expansion_name,
            "slug": slug,
            "symbolImageUrl": "",
            "logoImageUrl": "",
            "defaultSymbolUrl": if slug.is_empty() {
                String::new()
            } else {
                format!("https://cdn.pokoin.com/expansions/symbols/{slug}.png")
            },
            "cardCount": 0,
            "nationality": "",
        }));
    }
    let Some(expansion) = expansion else {
        return support::json_with_cors(
            StatusCode::NOT_FOUND,
            json!({ "error": "Expansion not found.", "slug": slug, "expansionName": expansion_name }),
        );
    };

    let expansion_name_value = js::string_or_empty(js::get(&expansion, "name"));
    let fetched: Vec<Value> = if product_type == "card" {
        // Production readSetCards: indexed set SQL + canonical/cheapest overlay.
        match read_set_cards(&pool, is_pokemon, &expansion_name_value, limit + 1, offset).await {
            Ok(rows) => rows,
            Err(error) => {
                return support::node_error_response(&error, "Marketplace expansion page failed.")
            }
        }
    } else {
        let args = card_versions::RowsForVersionsArgs {
            expansion_name: expansion_name_value.clone(),
            product_type: product_type.clone(),
            limit: offset + limit + 1,
            ..Default::default()
        };
        match card_versions::rows_for_versions(&pool, &args).await {
            Ok(rows) => rows,
            Err(error) => {
                return support::node_error_response(&error, "Marketplace expansion page failed.")
            }
        }
    };

    let from_set_sql = product_type == "card";
    let page: Vec<Value> = if from_set_sql {
        fetched.iter().take(limit as usize).cloned().collect()
    } else {
        fetched
            .iter()
            .skip(offset as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    };
    let print = js::string_or_empty(js::get(&expansion, "nationality"))
        .trim()
        .to_string();
    let cards: Vec<Value> = react_card::to_react_cards(&page)
        .into_iter()
        .map(|card| {
            let card_nationality = js::string_or_empty(js::get(&card, "nationality"));
            if !card_nationality.is_empty() || print.is_empty() {
                card
            } else {
                js::spread_with(&card, "nationality", Value::String(print.clone()))
            }
        })
        .collect();

    let mut total = js::number(js::get(&expansion, "cardCount"));
    if !total.is_finite() {
        total = 0.0;
    }
    if !expansion_name_value.is_empty() {
        // try/catch keeps expansion.cardCount on failure.
        if let Ok(stored) =
            react_sql::read_stored_catalog_card_count(&pool, is_pokemon, &expansion_name_value)
                .await
        {
            if stored >= 0 {
                total = stored as f64;
            }
        }
    }
    let expansion = js::spread_with(&expansion, "cardCount", js::js_json_number(total));

    let has_more = if from_set_sql {
        fetched.len() as i64 > limit
    } else {
        fetched.len() as i64 > offset + limit
    };
    support::json_with_cache_control_c1(
        wanted,
        StatusCode::OK,
        success_body(
            expansion,
            cards,
            &product_type,
            limit,
            offset,
            total,
            has_more,
        ),
        SET_CACHE,
    )
}

/// Set desks are rebuilt every 15 minutes (`build-lists-sets`); the live
/// fallback sends the same policy so one URL never flips between two.
const SET_CACHE: &str = "public, max-age=60, s-maxage=600, stale-while-revalidate=3600";
const SET_INDEX_CACHE: &str = "public, max-age=60, s-maxage=600, stale-while-revalidate=3600";

/// [`success_body`] from a `set` snapshot window, byte for byte.
fn set_bytes(page: &page_snapshot::Page, limit: i64, offset: i64) -> Option<Vec<u8>> {
    let expansion = page.head.get("expansion").filter(|v| v.is_object())?;
    let total = page.head.get("total")?;
    let has_more = page.row_count as i64 > offset + limit;
    Some(
        page_snapshot::Body::with_capacity(&page.rows)
            .value("expansion", expansion)
            .rows("cards", &page.rows)
            .value("productType", &json!("card"))
            .value("limit", &json!(limit))
            .value("offset", &json!(offset))
            .value("count", &json!(page.rows.len()))
            .value("total", total)
            .value("hasMore", &json!(has_more))
            .finish(),
    )
}

/// [`no_slug_body`] from the `set-index` snapshot, byte for byte.
fn index_bytes(rows: &[String], game: &str, limit: i64) -> Vec<u8> {
    page_snapshot::Body::with_capacity(rows)
        .rows("expansions", rows)
        .value("expansion", &Value::Null)
        .rows("cards", &[])
        .value("game", &json!(game))
        .value("limit", &json!(limit))
        .value("offset", &json!(0))
        .value("hasMore", &json!(false))
        .finish()
}

/// The browse-page success body (`jsonOk` payload of the reference).
pub fn success_body(
    expansion: Value,
    cards: Vec<Value>,
    product_type: &str,
    limit: i64,
    offset: i64,
    total: f64,
    has_more: bool,
) -> Value {
    json!({
        "expansion": expansion,
        "cards": cards,
        "productType": product_type,
        "limit": limit,
        "offset": offset,
        "count": cards.len(),
        "total": js::js_json_number(total),
        "hasMore": has_more,
    })
}

/// The no-slug listing body.
pub fn no_slug_body(expansions: Vec<Value>, game: &str, limit: i64) -> Value {
    json!({
        "expansions": expansions,
        "expansion": Value::Null,
        "cards": [],
        "game": game,
        "limit": limit,
        "offset": 0,
        "hasMore": false,
    })
}

/// The production `readSetCards` dependency of `createHandler`:
/// `readCardsForSet` + canonical paths + cheapest overlay.
async fn read_set_cards(
    pool: &sqlx::PgPool,
    is_pokemon: bool,
    set_name: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows = react_sql::read_cards_for_set(pool, is_pokemon, set_name, limit, offset).await?;
    let ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| {
            let n = js::number(js::get(row, "card_id"));
            (js::is_safe_integer(n) && n > 0.0).then_some(n as i64)
        })
        .collect();
    let blueprint_ids: Vec<i64> = rows
        .iter()
        .filter_map(|row| {
            let n = js::number(js::get(row, "ct_id"));
            (js::is_safe_integer(n) && n > 0.0).then_some(n as i64)
        })
        .collect();
    let paths = react_sql::read_canonical_paths(pool, &ids).await?;
    let cheapest = react_sql::read_cheapest_map(pool, is_pokemon, &ids, &blueprint_ids).await;
    Ok(react_sql::apply_canonical_and_cheapest(
        &rows, &paths, &cheapest,
    ))
}

/// 405 for every method the reference rejects.
pub async fn method_not_allowed() -> Response {
    support::method_not_allowed_get_options().await
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    fn cards(n: usize) -> Vec<Value> {
        (0..n).map(|i| json!({"id": i.to_string(), "card_id": i.to_string(), "name": "Pikachu", "price": 12.5, "nationality": ""})).collect()
    }

    #[test]
    fn a_snapshot_page_is_the_live_body() {
        let all = cards(5);
        let expansion = json!({"name": "Base Set", "slug": "base-set", "cardCount": 102});
        for (limit, offset) in [(2_i64, 0_i64), (2, 2), (2, 4), (400, 0), (2, 9)] {
            let window: Vec<Value> = all.iter().skip(offset as usize).take(limit as usize).cloned().collect();
            let page = page_snapshot::Page {
                head: json!({"expansion": expansion, "total": 102}),
                rows: window.iter().map(page_snapshot::text).collect(),
                row_count: all.len(),
                c1: None,
            };
            let has_more = all.len() as i64 > offset + limit;
            let live = success_body(expansion.clone(), window, "card", limit, offset, 102.0, has_more);
            assert_eq!(String::from_utf8(set_bytes(&page, limit, offset).unwrap()).unwrap(), live.to_string());
        }
    }

    #[test]
    fn the_snapshot_index_is_the_live_body() {
        let expansions = cards(3);
        let rows: Vec<String> = expansions.iter().map(page_snapshot::text).collect();
        let live = no_slug_body(expansions, "pokemon", 400);
        assert_eq!(String::from_utf8(index_bytes(&rows, "pokemon", 400)).unwrap(), live.to_string());
    }
}
