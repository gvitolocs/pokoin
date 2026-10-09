//! Marketplace grounding of `pokoin-assistant.js`: the read-only SQL queries
//! (`resolveMarketplaceCards`, `activeListingGrounding`,
//! `analyticsGrounding`, `cardLookupGrounding`, `queryCardRecommendations`,
//! `queryDeckAdvisorData`, `resolveCardQueryPath`), the row mappers
//! (`marketplaceCardFromRow`, `recommendationCardFromRow`,
//! `deckRowToAdvisorDeck`) and the deterministic reply composers.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Map, Value};
use sqlx::{PgPool, Row};

use crate::assistant::context::{clean_internal_path, marketplace_card_path};
use crate::assistant::intent::{
    deck_advisor_fallback_decks, deck_archetype_notes, DeckAdvisorIntent,
};
use crate::assistant::text::{
    clean_text, clean_text_str, format_pkn, normalize_intent_text, re, slug_part,
};

const DECK_ADVISOR_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// A DB row with node-pg JSON semantics: numerics read back as their Postgres
/// text form, ints as numbers, missing as null.
struct JsRow<'r>(&'r sqlx::postgres::PgRow);

impl JsRow<'_> {
    fn opt_text(&self, column: &str) -> Option<String> {
        self.0.try_get::<Option<String>, _>(column).unwrap_or(None)
    }

    fn text_or(&self, column: &str, fallback: &str) -> String {
        self.opt_text(column).unwrap_or_else(|| fallback.to_owned())
    }

    fn opt_i64(&self, column: &str) -> Option<i64> {
        self.0.try_get::<Option<i64>, _>(column).unwrap_or(None)
    }

    fn int_or(&self, column: &str, fallback: f64) -> f64 {
        self.opt_i64(column)
            .map(|value| value as f64)
            .unwrap_or(fallback)
    }

    /// NUMERIC columns: node-pg hands them to JS as strings.
    fn numeric_string(&self, column: &str) -> Option<String> {
        self.0
            .try_get::<Option<sqlx::types::BigDecimal>, _>(column)
            .unwrap_or(None)
            .map(|value| value.to_string())
    }

    fn number_of(&self, column: &str) -> Option<f64> {
        self.numeric_string(column)
            .and_then(|text| text.parse::<f64>().ok())
    }

    fn json(&self, column: &str) -> Value {
        self.0
            .try_get::<Option<Value>, _>(column)
            .unwrap_or(None)
            .unwrap_or(Value::Null)
    }
}

/// `marketplaceCardFromRow` -> the JS object as ordered JSON.
pub fn marketplace_card_from_row(row: &sqlx::postgres::PgRow, language: &str) -> Value {
    let row = JsRow(row);
    let card_id = row
        .opt_i64("card_id")
        .map(|id| id.to_string())
        .unwrap_or_default();
    let name = {
        let card_name = row.text_or("card_name", "");
        if !card_name.is_empty() {
            card_name
        } else {
            let display = row.text_or("display_name", "");
            if !display.is_empty() {
                display
            } else {
                let canonical = row.text_or("canonical_name", "");
                if !canonical.is_empty() {
                    canonical
                } else {
                    row.text_or("name", "")
                }
            }
        }
    };
    let collector_number = {
        let collector = row.text_or("collector_number", "");
        if !collector.is_empty() {
            collector
        } else {
            row.text_or("card_number", "")
        }
    };
    // canonicalMarketplacePath({...row, card_id, card_name: name,
    // collector_number}) — the path builder reads only these fields.
    let mut path_row = Map::new();
    path_row.insert("card_id".into(), json!(card_id));
    path_row.insert("card_name".into(), json!(name));
    path_row.insert("name".into(), json!(row.text_or("name", "")));
    path_row.insert("collector_number".into(), json!(collector_number));
    path_row.insert("card_number".into(), json!(row.text_or("card_number", "")));
    path_row.insert("set_name".into(), json!(row.text_or("set_name", "")));
    path_row.insert("rarity".into(), json!(row.text_or("rarity", "")));
    path_row.insert(
        "canonical_path".into(),
        row.opt_text("canonical_path")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    let path = canonical_marketplace_path(&path_row, language);
    let floor = row.number_of("lowest_ask_pkn");
    json!({
        "cardId": card_id,
        "name": name,
        "setName": row.text_or("set_name", ""),
        "collectorNumber": collector_number,
        "rarity": row.text_or("rarity", ""),
        "path": path,
        "url": if path.is_empty() { "".to_owned() } else { format!("https://pokoin.com{path}") },
        "activeListingCount": row.int_or("active_listing_count", row.int_or("listing_count", 0.0)),
        "listedQuantity": row.int_or("listed_quantity", 0.0),
        "floorPricePkn": floor,
        "hotScore24h": row.number_of("hot_score_24h").unwrap_or(0.0),
        "views24h": row.int_or("views_24h", 0.0),
        "searches24h": row.int_or("searches_24h", 0.0),
        "clicks24h": row.int_or("clicks_24h", 0.0),
    })
}

/// `canonicalMarketplacePath`.
pub fn canonical_marketplace_path(row: &Map<String, Value>, language: &str) -> String {
    let path = clean_text(row.get("canonical_path").unwrap_or(&Value::Null), 500);
    if !path.is_empty() && re("(?i)^/marketplace/[a-z]{2}/cards/[0-9]+/[a-z0-9-]+$").is_match(&path)
    {
        let clean_language = {
            let part = slug_part(language);
            if part.is_empty() {
                "en".to_owned()
            } else {
                part
            }
        };
        return re("(?i)^/marketplace/[a-z]{2}/")
            .replace(&path, format!("/marketplace/{clean_language}/"))
            .into_owned();
    }
    marketplace_card_path(row, language)
}

async fn query_rows(
    pool: &PgPool,
    sql: &str,
    values: &[Value],
) -> Result<Vec<sqlx::postgres::PgRow>, sqlx::Error> {
    let mut query = sqlx::query(sql);
    for value in values {
        query = match value {
            Value::String(text) => query.bind(text.clone()),
            Value::Number(number) => {
                if let Some(int) = number.as_i64() {
                    if int >= i32::MIN as i64 && int <= i32::MAX as i64 {
                        query.bind(int as i32)
                    } else {
                        query.bind(int)
                    }
                } else {
                    query.bind(number.as_f64())
                }
            }
            Value::Bool(flag) => query.bind(*flag),
            Value::Null => query.bind(Option::<String>::None),
            Value::Array(items) => {
                let strings: Vec<String> = items
                    .iter()
                    .map(|item| match item {
                        Value::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect();
                query.bind(strings)
            }
            other => query.bind(other.to_string()),
        };
    }
    query.fetch_all(pool).await
}

fn clean_limit(limit: f64) -> i32 {
    // `Math.min(Math.max(Number(limit) || 5, 1), 10)`: 0/NaN fall back to 5.
    let value = if limit.is_finite() && limit != 0.0 {
        limit
    } else {
        5.0
    };
    (value.trunc() as i64).clamp(1, 10) as i32
}

/// `resolveMarketplaceCards`.
pub async fn resolve_marketplace_cards(
    pool: &PgPool,
    query: &str,
    card_id: &str,
    language: &str,
    limit: f64,
) -> Result<Vec<Value>, sqlx::Error> {
    let values = vec![
        json!(clean_text_str(query, 120)),
        json!(clean_text_str(card_id, 80)),
        json!(clean_limit(limit)),
    ];
    let rows = query_rows(
        pool,
        r#"
      with input as (
        select
          lower($1::text) as q,
          $2::text as card_id,
          $3::integer as clean_limit
      )
      select
        candidates.card_id,
        coalesce(nullif(candidates.display_name, ''), nullif(candidates.canonical_name, ''), candidates.name) as card_name,
        candidates.display_name,
        candidates.canonical_name,
        candidates.name,
        candidates.set_name,
        candidates.card_number,
        candidates.rarity,
        urls.canonical_path,
        summary.lowest_ask_pkn,
        summary.active_listing_count,
        summary.listed_quantity,
        hot.views_24h,
        hot.searches_24h,
        hot.clicks_24h,
        hot.hot_score_24h
      from public.marketplace_search_candidates candidates
      cross join input
      left join public.marketplace_card_urls urls
        on urls.card_id = candidates.card_id
      left join public.marketplace_blueprint_price_summary summary
        on summary.blueprint_id = candidates.card_id
      left join public.marketplace_hot_blueprints hot
        on hot.blueprint_id = candidates.card_id
      where (
        input.card_id <> '' and candidates.card_id::text = input.card_id
      ) or (
        input.card_id = ''
        and input.q <> ''
        and (
          lower(coalesce(nullif(candidates.display_name, ''), nullif(candidates.canonical_name, ''), candidates.name, '')) like '%' || input.q || '%'
          or lower(coalesce(candidates.name, '')) like '%' || input.q || '%'
          or lower(coalesce(candidates.set_name, '')) like '%' || input.q || '%'
          or lower(coalesce(candidates.card_number, '')) = input.q
        )
      )
      order by
        case
          when input.card_id <> '' then 0
          when lower(coalesce(nullif(candidates.display_name, ''), nullif(candidates.canonical_name, ''), candidates.name, '')) = input.q then 0
          when lower(coalesce(candidates.name, '')) = input.q then 1
          when lower(coalesce(nullif(candidates.display_name, ''), nullif(candidates.canonical_name, ''), candidates.name, '')) like input.q || '%' then 2
          else 3
        end,
        coalesce(summary.active_listing_count, 0) desc,
        candidates.search_weight desc,
        candidates.card_id desc
      limit (select clean_limit from input)
    "#,
        &values,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|row| marketplace_card_from_row(row, language))
        .collect())
}

/// The raw listing row JSON with node-pg types (uuid string, numeric string).
fn listing_row_to_json(row: &sqlx::postgres::PgRow) -> Value {
    let row = JsRow(row);
    let mut listing = Map::new();
    listing.insert("listing_id".into(), json!(row.text_or("listing_id", "")));
    listing.insert("card_id".into(), json!(row.text_or("card_id", "")));
    listing.insert(
        "card_name".into(),
        row.opt_text("card_name")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "price_pkn".into(),
        row.number_of("price_pkn")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "quantity_available".into(),
        row.opt_i64("quantity_available")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "condition".into(),
        row.opt_text("condition")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "language".into(),
        row.opt_text("language")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "foil_state".into(),
        row.opt_text("foil_state")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "graded".into(),
        row.0
            .try_get::<Option<bool>, _>("graded")
            .unwrap_or(None)
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "grade".into(),
        row.opt_text("grade")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "seller_name".into(),
        row.opt_text("seller_name")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "set_name".into(),
        row.opt_text("set_name")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "collector_number".into(),
        row.opt_text("collector_number")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "name".into(),
        row.opt_text("name")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "rarity".into(),
        row.opt_text("rarity")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "canonical_path".into(),
        row.opt_text("canonical_path")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "lowest_ask_pkn".into(),
        row.numeric_string("lowest_ask_pkn")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "active_listing_count".into(),
        row.opt_i64("active_listing_count")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "listed_quantity".into(),
        row.opt_i64("listed_quantity")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "views_24h".into(),
        row.opt_i64("views_24h")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "searches_24h".into(),
        row.opt_i64("searches_24h")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "clicks_24h".into(),
        row.opt_i64("clicks_24h")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    listing.insert(
        "hot_score_24h".into(),
        row.numeric_string("hot_score_24h")
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    Value::Object(listing)
}

/// `activeListingGrounding`.
pub async fn active_listing_grounding(
    pool: &PgPool,
    request_query: &str,
    request_card_id: &str,
    mode: &str,
    language: &str,
) -> Result<Value, sqlx::Error> {
    let values = vec![
        json!(if request_query.is_empty() {
            String::new()
        } else {
            format!("%{request_query}%")
        }),
        json!(clean_text_str(request_card_id, 80)),
        json!(if mode == "highest" { "desc" } else { "asc" }),
    ];
    let rows = query_rows(
        pool,
        r#"
      with input as (
        select
          $1::text as q,
          $2::text as card_id,
          $3::text as direction
      )
      select
        listings.id as listing_id,
        listings.card_id,
        coalesce(nullif(listings.card_name, ''), nullif(candidates.display_name, ''), nullif(candidates.canonical_name, ''), candidates.name) as card_name,
        listings.price_pkn,
        listings.quantity_available,
        listings.condition,
        listings.language,
        listings.foil_state,
        listings.graded,
        listings.grade,
        listings.seller_name,
        coalesce(nullif(listings.set_name, ''), candidates.set_name) as set_name,
        coalesce(nullif(listings.collector_number, ''), candidates.card_number) as collector_number,
        candidates.name,
        candidates.rarity,
        urls.canonical_path,
        summary.lowest_ask_pkn,
        summary.active_listing_count,
        summary.listed_quantity,
        hot.views_24h,
        hot.searches_24h,
        hot.clicks_24h,
        hot.hot_score_24h
      from public.marketplace_user_listings listings
      cross join input
      left join public.marketplace_search_candidates candidates
        on candidates.card_id::text = listings.card_id::text
      left join public.marketplace_card_urls urls
        on urls.card_id::text = listings.card_id::text
      left join public.marketplace_blueprint_price_summary summary
        on summary.blueprint_id::text = listings.card_id::text
      left join public.marketplace_hot_blueprints hot
        on hot.blueprint_id::text = listings.card_id::text
      where listings.status = 'active'
        and listings.quantity_available > 0
        and listings.price_pkn > 0
        and (
          input.card_id <> '' and listings.card_id::text = input.card_id
          or input.card_id = '' and (
            input.q = ''
            or lower(coalesce(listings.card_name, candidates.display_name, candidates.canonical_name, candidates.name, '')) like lower(input.q)
            or lower(coalesce(candidates.set_name, '')) like lower(input.q)
          )
        )
      order by
        case when input.direction = 'desc' then listings.price_pkn end desc,
        case when input.direction <> 'desc' then listings.price_pkn end asc,
        listings.updated_at desc nulls last,
        listings.created_at desc nulls last
      limit 1
    "#,
        &values,
    )
    .await?;
    let listing = rows.first().map(listing_row_to_json);
    let cards = if listing.is_some() {
        Vec::new()
    } else {
        resolve_marketplace_cards(pool, request_query, request_card_id, language, 3.0)
            .await
            .unwrap_or_default()
    };
    Ok(json!({
        "type": "active_listing",
        "mode": mode,
        "query": request_query,
        "cardId": request_card_id,
        "listing": listing,
        "cards": cards,
    }))
}

/// `analyticsGrounding`.
pub async fn analytics_grounding(
    pool: &PgPool,
    request_query: &str,
    request_card_id: &str,
    language: &str,
) -> Result<Value, sqlx::Error> {
    let values = vec![json!(request_query), json!(request_card_id)];
    let rows = query_rows(
        pool,
        r#"
      with input as (
        select lower($1::text) as q, $2::text as card_id
      )
      select
        hot.blueprint_id as card_id,
        hot.name as card_name,
        hot.set_name,
        hot.card_number,
        hot.rarity,
        urls.canonical_path,
        summary.lowest_ask_pkn,
        summary.active_listing_count,
        summary.listed_quantity,
        hot.views_24h,
        hot.searches_24h,
        hot.clicks_24h,
        hot.cart_adds_24h,
        hot.reserves_24h,
        hot.sales_24h,
        hot.hot_score_24h,
        hot.last_event_at,
        hot.refreshed_at
      from public.marketplace_hot_blueprints hot
      cross join input
      left join public.marketplace_card_urls urls
        on urls.card_id = hot.blueprint_id
      left join public.marketplace_blueprint_price_summary summary
        on summary.blueprint_id = hot.blueprint_id
      where hot.hot_score_24h > 0
        and (
          input.card_id <> '' and hot.blueprint_id::text = input.card_id
          or input.card_id = '' and (
            input.q = ''
            or lower(coalesce(hot.name, '')) like '%' || input.q || '%'
            or lower(coalesce(hot.set_name, '')) like '%' || input.q || '%'
            or lower(coalesce(hot.card_number, '')) = input.q
          )
        )
      order by hot.hot_score_24h desc, hot.last_event_at desc nulls last, hot.blueprint_id desc
      limit 5
    "#,
        &values,
    )
    .await?;
    Ok(json!({
        "type": "analytics",
        "mode": "hot",
        "query": request_query,
        "cardId": request_card_id,
        "cards": rows.iter().map(|row| marketplace_card_from_row(row, language)).collect::<Vec<_>>(),
    }))
}

/// `cardLookupGrounding`.
pub async fn card_lookup_grounding(
    pool: &PgPool,
    request_query: &str,
    request_card_id: &str,
    language: &str,
) -> Result<Value, sqlx::Error> {
    let cards =
        resolve_marketplace_cards(pool, request_query, request_card_id, language, 5.0).await?;
    Ok(json!({
        "type": "card_lookup",
        "mode": "suggest",
        "query": request_query,
        "cardId": request_card_id,
        "cards": cards,
    }))
}

/// `noDataMarketplaceReply`.
pub fn no_data_marketplace_reply(grounding: &Value) -> String {
    let query = grounding.get("query").and_then(Value::as_str).unwrap_or("");
    let card_id = grounding
        .get("cardId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let subject = if !query.is_empty() {
        query
    } else if !card_id.is_empty() {
        card_id
    } else {
        "that card"
    };
    match grounding.get("type").and_then(Value::as_str) {
        Some("active_listing") => format!(
            "I checked active Pokoin marketplace listings, but I could not find any active listing for {subject} right now. Source: marketplace_user_listings active listings."
        ),
        Some("analytics") => format!(
            "I checked Pokoin marketplace analytics, but I do not have hot/popularity data for {subject} right now. Source: marketplace_hot_blueprints."
        ),
        _ => format!(
            "I checked Pokoin marketplace search data, but I could not resolve a direct card page for {subject} right now."
        ),
    }
}

/// `groundedMarketplaceReply` -> {reply, actions}.
pub fn grounded_marketplace_reply(grounding: &Value, language: &str) -> Value {
    let grounding_type = grounding.get("type").and_then(Value::as_str).unwrap_or("");
    if grounding_type == "active_listing" {
        let listing = grounding.get("listing").cloned().unwrap_or(Value::Null);
        let cards = grounding
            .get("cards")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if listing.is_null() {
            let first_url = cards
                .first()
                .and_then(|card| card.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let extra = if !first_url.is_empty() {
                format!(" I did find a matching card page: {first_url}")
            } else {
                String::new()
            };
            let first_path = cards
                .first()
                .and_then(|card| card.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let actions = if !first_path.is_empty() {
                json!([{
                    "type": "navigate",
                    "path": first_path,
                    "label": format!("Open {}", cards[0].get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("card")),
                    "reason": "marketplace_no_listing_card_match",
                }])
            } else {
                json!([])
            };
            return json!({
                "reply": format!("{}{extra}", no_data_marketplace_reply(grounding)),
                "actions": actions,
            });
        }
        let path = {
            let mut row = Map::new();
            for (key, value) in listing.as_object().into_iter().flatten() {
                row.insert(key.clone(), value.clone());
            }
            canonical_marketplace_path(&row, language)
        };
        let name = {
            let card_name = listing
                .get("card_name")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !card_name.is_empty() {
                card_name.to_owned()
            } else {
                let name = listing.get("name").and_then(Value::as_str).unwrap_or("");
                if !name.is_empty() {
                    name.to_owned()
                } else {
                    "this card".to_owned()
                }
            }
        };
        let mode = grounding.get("mode").and_then(Value::as_str).unwrap_or("");
        let mode_label = match mode {
            "floor" => "lowest active ask",
            "best_deal" => "lowest active ask I can treat as a deal signal",
            _ => "highest-priced active listing",
        };
        let condition = listing
            .get("condition")
            .and_then(Value::as_str)
            .unwrap_or("");
        let language_field = listing
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("");
        let quantity = listing
            .get("quantity_available")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let seller = listing
            .get("seller_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut details: Vec<String> = Vec::new();
        if !condition.is_empty() {
            details.push(format!("condition {condition}"));
        }
        if !language_field.is_empty() {
            details.push(format!("language {language_field}"));
        }
        if quantity != 0.0 {
            details.push(format!(
                "quantity {}",
                super::text::js_number_to_string(quantity)
            ));
        }
        if !seller.is_empty() {
            details.push(format!("seller {seller}"));
        }
        let details = details.join(", ");
        let price = listing
            .get("price_pkn")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let reply = [
            Some(format!(
                "I checked active Pokoin marketplace listings. The {mode_label} I found is {name} at {} PKN{}.",
                format_pkn(price),
                if details.is_empty() { String::new() } else { format!(" ({details})") }
            )),
            if path.is_empty() {
                None
            } else {
                Some(format!("Direct card page: https://pokoin.com{path}"))
            },
            Some("Source: marketplace_user_listings active listings and price summary. Not financial advice.".to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n\n");
        let actions = if path.is_empty() {
            json!([])
        } else {
            json!([{
                "type": "navigate",
                "path": path,
                "label": format!("Open {name}"),
                "reason": format!("marketplace_{mode}"),
                "data": {
                    "cardId": listing.get("card_id").and_then(Value::as_str).unwrap_or("").to_string(),
                    "listingId": listing.get("listing_id").and_then(Value::as_str).unwrap_or("").to_string(),
                    "pricePkn": price,
                    "name": name,
                    "grounded": true,
                },
            }])
        };
        return json!({ "reply": reply, "actions": actions });
    }
    if grounding_type == "analytics" {
        let cards = grounding
            .get("cards")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if cards.is_empty() {
            return json!({ "reply": no_data_marketplace_reply(grounding), "actions": [] });
        }
        let lines: Vec<String> = cards
            .iter()
            .take(3)
            .enumerate()
            .map(|(index, card)| {
                let views = card.get("views24h").and_then(Value::as_f64).unwrap_or(0.0);
                let searches = card
                    .get("searches24h")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let clicks = card.get("clicks24h").and_then(Value::as_f64).unwrap_or(0.0);
                let signals = format!(
                    "{} views, {} searches, {} clicks in 24h",
                    super::text::js_number_to_string(views),
                    super::text::js_number_to_string(searches),
                    super::text::js_number_to_string(clicks)
                );
                let floor = card.get("floorPricePkn");
                let price = match floor {
                    Some(Value::Number(number)) => {
                        format!("floor {} PKN", format_pkn(number.as_f64().unwrap_or(0.0)))
                    }
                    _ => "no active floor price".to_owned(),
                };
                let set_name = card.get("setName").and_then(Value::as_str).unwrap_or("");
                let name = card.get("name").and_then(Value::as_str).unwrap_or("");
                let hot = card
                    .get("hotScore24h")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let url = card.get("url").and_then(Value::as_str).unwrap_or("");
                format!(
                    "{}. {}{}: hot score {}, {}, {}{}",
                    index + 1,
                    name,
                    if set_name.is_empty() {
                        String::new()
                    } else {
                        format!(" ({set_name})")
                    },
                    format_pkn(hot),
                    signals,
                    price,
                    if url.is_empty() {
                        String::new()
                    } else {
                        format!("\n{url}")
                    }
                )
            })
            .collect();
        let query = grounding.get("query").and_then(Value::as_str).unwrap_or("");
        let first = &cards[0];
        let first_path = first.get("path").and_then(Value::as_str).unwrap_or("");
        let actions = if !first_path.is_empty() {
            json!([{
                "type": "navigate",
                "path": first_path,
                "label": format!("Open {}", first.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("top card")),
                "reason": "marketplace_hot_blueprint",
                "data": {
                    "cardId": first.get("cardId").cloned().unwrap_or(Value::String(String::new())),
                    "grounded": true,
                },
            }])
        } else {
            json!([])
        };
        let analytics_opening = if query.is_empty() {
            "I checked Pokoin marketplace analytics.".to_owned()
        } else {
            format!("I checked Pokoin marketplace analytics for {query}.")
        };
        let analytics_body = [
            analytics_opening,
            lines.join("\n\n"),
            "Source: marketplace_hot_blueprints plus active listing price summary. This is marketplace activity, not financial advice.".to_owned(),
        ]
        .join("\n\n");
        return json!({
            "reply": analytics_body,
            "actions": actions,
        });
    }
    let cards = grounding
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if cards.is_empty() {
        return json!({ "reply": no_data_marketplace_reply(grounding), "actions": [] });
    }
    let card = &cards[0];
    let name = card.get("name").and_then(Value::as_str).unwrap_or("");
    let set_name = card.get("setName").and_then(Value::as_str).unwrap_or("");
    let collector = card
        .get("collectorNumber")
        .and_then(Value::as_str)
        .unwrap_or("");
    let url = card.get("url").and_then(Value::as_str).unwrap_or("");
    let path = card.get("path").and_then(Value::as_str).unwrap_or("");
    let floor = card.get("floorPricePkn");
    let floor_line = match floor {
        Some(Value::Number(number)) => format!(
            "Current floor from active listings: {} PKN.",
            format_pkn(number.as_f64().unwrap_or(0.0))
        ),
        _ => "I do not see an active floor price for it right now.".to_owned(),
    };
    let reply = [
        Some(format!(
            "I resolved the best marketplace card match: {}{}{}.",
            name,
            if set_name.is_empty() { String::new() } else { format!(" ({set_name})") },
            if collector.is_empty() { String::new() } else { format!(" {collector}") }
        )),
        if url.is_empty() { None } else { Some(format!("Direct card page: {url}")) },
        Some(floor_line),
        Some("Source: marketplace_search_candidates, marketplace_card_urls, and price summary. Not financial advice.".to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    let actions = if path.is_empty() {
        json!([])
    } else {
        json!([{
            "type": "navigate",
            "path": path,
            "label": format!("Open {}", if name.is_empty() { "card" } else { name }),
            "reason": "marketplace_card_lookup",
            "data": {
                "cardId": card.get("cardId").cloned().unwrap_or(Value::String(String::new())),
                "grounded": true,
            },
        }])
    };
    json!({ "reply": reply, "actions": actions })
}

/// `recommendationCardFromRow`.
fn recommendation_card_from_row(row: &sqlx::postgres::PgRow, language: &str) -> Value {
    let card = marketplace_card_from_row(row, language);
    let mut object = card.as_object().cloned().unwrap_or_default();
    let row = JsRow(row);
    object.insert(
        "score".into(),
        json!(row.number_of("recommendation_score").unwrap_or(0.0)),
    );
    object.insert("artist".into(), {
        let artist = row.text_or("artist", "");
        if !artist.is_empty() {
            json!(artist)
        } else {
            json!(row.text_or("illustrator", ""))
        }
    });
    let types = row.json("types");
    object.insert(
        "types".into(),
        if types.is_array() { types } else { json!([]) },
    );
    object.insert("flavorText".into(), json!(row.text_or("flavor_text", "")));
    object.insert(
        "cardtraderCheapestPkn".into(),
        row.number_of("cardtrader_cheapest_pkn")
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    object.insert(
        "cardtraderEligibleListings".into(),
        json!(row.int_or("cardtrader_eligible_listing_count", 0.0)),
    );
    object.insert("sales24h".into(), json!(row.int_or("sales_24h", 0.0)));
    object.insert(
        "cartAdds24h".into(),
        json!(row.int_or("cart_adds_24h", 0.0)),
    );
    Value::Object(object)
}

/// `queryCardRecommendations`.
pub async fn query_card_recommendations(
    pool: &PgPool,
    subject: &str,
    theme: &str,
    styles: &[String],
    budget: &str,
    language: &str,
    favorite_pokemon: &[String],
    limit: f64,
) -> Result<Vec<Value>, sqlx::Error> {
    let clean_subject = clean_text_str(subject, 120);
    let clean_theme = clean_text_str(theme, 60);
    let clean_styles = crate::assistant::text::unique_limited(styles, 8);
    let seeds = theme_seed_queries_for(
        &clean_subject,
        &clean_theme,
        &clean_styles,
        favorite_pokemon,
    );
    let values = vec![
        json!(clean_subject),
        json!(clean_theme),
        json!(clean_styles),
        json!(budget),
        json!(seeds),
        json!(clean_text_str(
            favorite_pokemon.first().map(String::as_str).unwrap_or(""),
            80
        )),
        json!(clean_limit(limit)),
    ];
    let rows = query_rows(
        pool,
        r#"
      with input as (
        select
          lower($1::text) as subject,
          lower($2::text) as theme,
          $3::text[] as styles,
          lower($4::text) as budget,
          $5::text[] as seeds,
          lower($6::text) as favorite,
          $7::integer as clean_limit
      ),
      seed_terms as (
        select lower(unnest(input.seeds)) as value from input
      ),
      candidates as (
        select
          c.card_id,
          coalesce(nullif(c.display_name, ''), nullif(c.canonical_name, ''), c.name) as card_name,
          c.display_name,
          c.canonical_name,
          c.name,
          c.set_name,
          c.card_number,
          c.rarity,
          c.search_text,
          c.search_weight,
          c.card_type,
          c.product_type,
          c.item_kind,
          urls.canonical_path,
          summary.lowest_ask_pkn,
          summary.active_listing_count,
          summary.listed_quantity,
          hot.views_24h,
          hot.searches_24h,
          hot.clicks_24h,
          hot.cart_adds_24h,
          hot.sales_24h,
          hot.hot_score_24h,
          cache.cheapest_price_pkn as cardtrader_cheapest_pkn,
          cache.eligible_listing_count as cardtrader_eligible_listing_count,
          artists.artist,
          artists.illustrator,
          metadata.types,
          metadata.flavor_text,
          (
            case
              when input.subject <> '' and lower(coalesce(nullif(c.display_name, ''), nullif(c.canonical_name, ''), c.name, '')) = input.subject then 800
              when input.subject <> '' and lower(coalesce(c.name, '')) = input.subject then 760
              when input.subject <> '' and lower(coalesce(c.search_text, c.name, '')) like '%' || input.subject || '%' then 560
              else 0
            end
            + case when input.favorite <> '' and lower(coalesce(c.search_text, c.name, '')) like '%' || input.favorite || '%' then 180 else 0 end
            + case when exists (select 1 from seed_terms where seed_terms.value <> '' and lower(coalesce(c.search_text, c.name, '')) like '%' || seed_terms.value || '%') then 420 else 0 end
            + case when 'illustration' = any(input.styles) and lower(coalesce(c.rarity, '')) like '%illustration%' then 140 else 0 end
            + case when 'cute' = any(input.styles) and (
                lower(coalesce(c.rarity, '')) like '%illustration%'
                or lower(coalesce(metadata.flavor_text, '')) ~ '(cute|tiny|sweet|play|friend|sleep|snow|dream|happy)'
                or lower(coalesce(c.name, '')) ~ '(mew|eevee|pikachu|snom|vulpix|vanillite|leafeon)'
              ) then 110 else 0 end
            + case when input.theme = 'ice_cream' and (
                lower(coalesce(c.search_text, c.name, '')) ~ '(vanillite|vanillish|vanilluxe|snom|lapras|vulpix|ice|snow|frost)'
                or lower(coalesce(metadata.types::text, '')) like '%water%'
              ) then 260 else 0 end
            + case when 'popular' = any(input.styles) then least(coalesce(hot.hot_score_24h, 0), 250) else least(coalesce(hot.hot_score_24h, 0), 80) end
            + case when input.budget = 'budget' and coalesce(summary.lowest_ask_pkn, cache.cheapest_price_pkn, 999999999) <= 500 then 120 else 0 end
            + case when input.budget = 'premium' and coalesce(summary.lowest_ask_pkn, cache.cheapest_price_pkn, 0) >= 1000 then 80 else 0 end
            + case when coalesce(summary.active_listing_count, 0) > 0 then 60 else 0 end
            + case when coalesce(cache.eligible_listing_count, 0) > 0 then 35 else 0 end
            + least(coalesce(c.search_weight, 0) / 100, 80)
          )::numeric as recommendation_score
        from public.marketplace_search_candidates c
        cross join input
        left join public.marketplace_card_urls urls on urls.card_id = c.card_id
        left join public.marketplace_blueprint_price_summary summary on summary.blueprint_id = c.card_id
        left join public.marketplace_hot_blueprints hot on hot.blueprint_id = c.card_id
        left join public.cardtrader_blueprint_listing_cache cache on cache.blueprint_id = c.card_id
        left join public.marketplace_blueprint_artists artists on artists.blueprint_id = c.card_id
        left join public.marketplace_blueprint_tcg_metadata metadata on metadata.blueprint_id = c.card_id
        where c.item_kind = 'single'
          and (
            input.subject <> ''
            or input.theme <> ''
            or array_length(input.styles, 1) is not null
            or input.favorite <> ''
          )
          and (
            input.subject = ''
            or lower(coalesce(c.search_text, c.name, '')) like '%' || input.subject || '%'
            or exists (select 1 from seed_terms where seed_terms.value <> '' and lower(coalesce(c.search_text, c.name, '')) like '%' || seed_terms.value || '%')
          )
      )
      select *
      from candidates
      where recommendation_score > 0
      order by
        case when $1::text <> '' and lower(coalesce(card_name, name, '')) = lower($1::text) then 0 else 1 end,
        recommendation_score desc,
        active_listing_count desc nulls last,
        hot_score_24h desc nulls last,
        card_id desc
      limit (select clean_limit from input)
    "#,
        &values,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|row| recommendation_card_from_row(row, language))
        .collect())
}

fn theme_seed_queries_for(
    subject: &str,
    theme_id: &str,
    styles: &[String],
    favorite_pokemon: &[String],
) -> Vec<String> {
    let mut seeds: Vec<String> = Vec::new();
    if !subject.is_empty() {
        seeds.push(subject.to_owned());
    }
    if theme_id == "ice_cream" || styles.iter().any(|style| style == "ice") {
        seeds.extend(
            [
                "Vanillite",
                "Vanillish",
                "Vanilluxe",
                "Alolan Vulpix",
                "Snom",
                "Lapras",
            ]
            .iter()
            .map(|seed| seed.to_string()),
        );
    }
    for pokemon in favorite_pokemon {
        seeds.push(pokemon.clone());
    }
    crate::assistant::text::unique_limited(&seeds, 8)
}

/// `recommendationReply` -> {reply, actions}.
pub fn recommendation_reply(
    intent: &Value,
    cards: &[Value],
    language: &str,
    preferences: &Map<String, Value>,
) -> Value {
    if cards.is_empty() {
        return json!({
            "reply": "I checked the read-only Pokoin marketplace card, URL, hotness, listing, stock, price, artist, and partner availability tables, but I could not resolve a safe direct card recommendation for that request.",
            "actions": [],
        });
    }
    let preference_language = preferences
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("");
    let intent_subject = intent.get("subject").and_then(Value::as_str).unwrap_or("");
    let italian = language == "it"
        || preference_language == "it"
        || crate::assistant::intent::is_italian_message(intent_subject);
    let card = &cards[0];
    let get_f64 = |key: &str| card.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    let mut signals: Vec<String> = Vec::new();
    let hot = get_f64("hotScore24h");
    if hot != 0.0 {
        signals.push(format!("hot score {}", format_pkn(hot)));
    }
    let views = get_f64("views24h");
    if views != 0.0 {
        signals.push(format!("{} views", super::text::js_number_to_string(views)));
    }
    let searches = get_f64("searches24h");
    if searches != 0.0 {
        signals.push(format!(
            "{} searches",
            super::text::js_number_to_string(searches)
        ));
    }
    let clicks = get_f64("clicks24h");
    if clicks != 0.0 {
        signals.push(format!(
            "{} clicks",
            super::text::js_number_to_string(clicks)
        ));
    }
    let sales = get_f64("sales24h");
    if sales != 0.0 {
        signals.push(format!(
            "{} sales/resolved sale signals",
            super::text::js_number_to_string(sales)
        ));
    }
    let active = get_f64("activeListingCount");
    if active != 0.0 {
        signals.push(format!(
            "{} active Pokoin listings",
            super::text::js_number_to_string(active)
        ));
    }
    let partner = get_f64("cardtraderEligibleListings");
    if partner != 0.0 {
        signals.push(format!(
            "{} partner availability listings",
            super::text::js_number_to_string(partner)
        ));
    }
    let signals = signals.join(", ");
    let floor = card.get("floorPricePkn");
    let partner_price = card.get("cardtraderCheapestPkn");
    let price = if floor.as_ref().map(|value| value.is_null()).unwrap_or(true)
        && partner_price
            .as_ref()
            .map(|value| value.is_null())
            .unwrap_or(true)
    {
        if italian {
            "Non vedo un floor affidabile ora.".to_owned()
        } else {
            "I do not see a reliable floor right now.".to_owned()
        }
    } else {
        let value = match floor {
            Some(Value::Number(number)) => number.as_f64(),
            _ => partner_price.and_then(Value::as_f64),
        }
        .unwrap_or(0.0);
        if italian {
            format!("Prezzo/floor indicativo: {} PKN.", format_pkn(value))
        } else {
            format!("Indicative floor/price: {} PKN.", format_pkn(value))
        }
    };
    let subject = intent.get("subject").and_then(Value::as_str).unwrap_or("");
    let theme_label = intent
        .get("themeLabel")
        .and_then(Value::as_str)
        .unwrap_or("");
    let explicit = intent
        .get("explicitSubject")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let favorites: Vec<String> = preferences
        .get("favoritePokemon")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let why = if explicit {
        if italian {
            format!("Ho rispettato prima il soggetto esplicito: {subject}.")
        } else {
            format!("I prioritized your explicit subject first: {subject}.")
        }
    } else if !theme_label.is_empty() {
        if italian {
            format!("Tema: {theme_label}.")
        } else {
            format!("Theme match: {theme_label}.")
        }
    } else if !favorites.is_empty() {
        let joined = favorites.join(", ");
        if italian {
            format!("Lo sto anche tarando sui tuoi gusti recenti: {joined}.")
        } else {
            format!("I am also biasing this toward your recent taste: {joined}.")
        }
    } else if italian {
        "Ho scelto usando pertinenza, disponibilità e segnali marketplace.".to_owned()
    } else {
        "I picked this using relevance, availability, and marketplace signals.".to_owned()
    };
    let name = card.get("name").and_then(Value::as_str).unwrap_or("");
    let set_name = card.get("setName").and_then(Value::as_str).unwrap_or("");
    let collector = card
        .get("collectorNumber")
        .and_then(Value::as_str)
        .unwrap_or("");
    let artist = card.get("artist").and_then(Value::as_str).unwrap_or("");
    let path = card.get("path").and_then(Value::as_str).unwrap_or("");
    let opening = if italian {
        format!(
            "Ti apro {}{}{}.",
            name,
            if set_name.is_empty() {
                String::new()
            } else {
                format!(" ({set_name})")
            },
            if collector.is_empty() {
                String::new()
            } else {
                format!(" {collector}")
            }
        )
    } else {
        format!(
            "I am opening {}{}{}.",
            name,
            if set_name.is_empty() {
                String::new()
            } else {
                format!(" ({set_name})")
            },
            if collector.is_empty() {
                String::new()
            } else {
                format!(" {collector}")
            }
        )
    };
    let source = if italian {
        "Fonte: peer4/read-only marketplace site data (search candidates, canonical URLs, hotness, listing/stock/price summary, artists, partner availability). Non è consulenza finanziaria."
    } else {
        "Source: peer4/read-only marketplace site data (search candidates, canonical URLs, hotness, listing/stock/price summary, artists, partner availability). Not financial advice."
    };
    let reply = [
        Some(opening),
        Some(why),
        Some(price),
        if signals.is_empty() {
            None
        } else if italian {
            Some(format!("Segnali letti: {signals}."))
        } else {
            Some(format!("Signals used: {signals}."))
        },
        if artist.is_empty() {
            None
        } else if italian {
            Some(format!("Artista: {artist}."))
        } else {
            Some(format!("Artist: {artist}."))
        },
        if path.is_empty() {
            None
        } else {
            Some(format!("https://pokoin.com{path}"))
        },
        Some(source.to_owned()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n\n");
    let actions = if path.is_empty() {
        json!([])
    } else {
        json!([{
            "type": "navigate",
            "path": path,
            "label": if italian {
                format!("Apri {}", if name.is_empty() { "carta" } else { name })
            } else {
                format!("Open {}", if name.is_empty() { "card" } else { name })
            },
            "reason": "marketplace_recommendation",
            "data": {
                "cardId": card.get("cardId").cloned().unwrap_or(Value::String(String::new())),
                "grounded": true,
                "direct": true,
                "recommendationScore": card.get("score").cloned().unwrap_or(json!(0)),
            },
        }])
    };
    json!({ "reply": reply, "actions": actions })
}

/// `deckRowToAdvisorDeck`.
fn deck_row_to_advisor_deck(row: &sqlx::postgres::PgRow) -> Value {
    let row = JsRow(row);
    let name = {
        let value = row.text_or("name", "");
        if !value.is_empty() {
            value
        } else {
            let archetype = row.text_or("archetype", "");
            if !archetype.is_empty() {
                archetype
            } else {
                "Unknown deck".to_owned()
            }
        }
    };
    let format_label = {
        let label = row.text_or("format_label", "");
        if !label.is_empty() {
            label
        } else {
            row.text_or("format", "")
        }
    };
    let tournament_date = row
        .0
        .try_get::<Option<chrono::NaiveDate>, _>("featured_tournament_date")
        .unwrap_or(None)
        .map(|date| json!(format!("{}T00:00:00.000Z", date.format("%Y-%m-%d"))));
    let deck_id = row.text_or("deck_id", "");
    let format = row.text_or("format", "");
    let rank = row.opt_i64("rank");
    let points = row.int_or("points", row.int_or("deck_count", 0.0));
    let share = row.number_of("share").unwrap_or(0.0);
    let source_url = row.text_or("source_url", "");
    let featured_decklist_id = row.text_or("featured_decklist_id", "");
    let featured_tournament_name = row.text_or("featured_tournament_name", "");
    json!({
        "deckId": deck_id,
        "name": name,
        "format": format,
        "formatLabel": format_label,
        "rank": rank,
        "points": points,
        "share": share,
        "sourceUrl": source_url,
        "featuredDecklistId": featured_decklist_id,
        "featuredTournamentName": featured_tournament_name,
        "featuredTournamentDate": tournament_date.unwrap_or(Value::Null),
        "coreCards": row.json("core_cards"),
        "recentResults": row.json("recent_results"),
    })
}

fn deck_advisor_cache() -> &'static Mutex<Vec<(String, Instant, Value)>> {
    static CACHE: OnceLock<Mutex<Vec<(String, Instant, Value)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// `queryDeckAdvisorData` with the process-local 10-minute cache.
pub async fn query_deck_advisor_data(
    pool: &PgPool,
    intent: &DeckAdvisorIntent,
) -> Result<Value, sqlx::Error> {
    let cache_key = crate::assistant::intent::deck_cache_key(intent);
    {
        let cache = match deck_advisor_cache().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((_, created, value)) = cache.iter().find(|(key, _, _)| *key == cache_key) {
            if created.elapsed() < DECK_ADVISOR_CACHE_TTL {
                return Ok(value.clone());
            }
        }
    }
    let values = vec![
        json!(clean_text_str(&intent.deck_name, 80)),
        json!(intent.beginner),
        json!(intent.budget),
        json!(clean_text_str(&intent.playstyle, 40)),
    ];
    let rows = query_rows(
        pool,
        r#"
      with input as (
        select lower($1::text) as deck_name, $2::boolean as beginner, $3::boolean as budget, lower($4::text) as playstyle
      ),
      candidate_decks as (
        select
          d.deck_id,
          d.name,
          d.format,
          d.format_label,
          d.rank,
          d.points,
          d.share,
          d.source_url,
          case
            when input.deck_name <> '' and lower(d.name) like '%' || input.deck_name || '%' then 500
            else 0
          end
          + case when input.beginner and lower(d.name) ~ '(miraidon|charizard|raging bolt|turbo)' then 80 else 0 end
          + case when input.playstyle = 'control' and lower(d.name) ~ '(control|snorlax|stall)' then 120 else 0 end
          + case when input.playstyle = 'aggressive' and lower(d.name) ~ '(miraidon|turbo|raging bolt|roaring moon)' then 120 else 0 end
          + coalesce(d.points, 0)
          + coalesce(d.share, 0) * 10
          - case when input.beginner and lower(d.name) ~ '(control|gardevoir|lost box)' then 30 else 0 end as advisor_score
        from public.limitless_public_decks d
        cross join input
        where input.deck_name = '' or lower(d.name) like '%' || input.deck_name || '%'
        order by advisor_score desc, d.rank asc nulls last, d.points desc, d.name asc
        limit 6
      )
      select
        d.*,
        featured.decklist_id as featured_decklist_id,
        featured.tournament_name as featured_tournament_name,
        featured.tournament_date as featured_tournament_date,
        coalesce(core.cards, '[]'::jsonb) as core_cards,
        coalesce(results.results, '[]'::jsonb) as recent_results
      from candidate_decks d
      left join lateral (
        select r.decklist_id, r.tournament_name, r.tournament_date
        from public.limitless_public_deck_results r
        where r.deck_id = d.deck_id
        order by r.tournament_date desc nulls last, r."placing" asc nulls last, r.player_name asc
        limit 1
      ) featured on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'name', c.display_name,
          'count', c.count,
          'inclusionShare', c.inclusion_share,
          'setCode', c.set_code,
          'collectorNumber', c.collector_number
        ) order by c.inclusion_share desc nulls last, c.count desc nulls last, c.display_name asc) as cards
        from (
          select *
          from public.limitless_public_deck_core_cards c
          where c.deck_id = d.deck_id
          order by c.inclusion_share desc nulls last, c.count desc nulls last, c.display_name asc
          limit 8
        ) c
      ) core on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'tournamentName', r.tournament_name,
          'tournamentDate', r.tournament_date,
          'placing', r."placing",
          'playerName', r.player_name,
          'decklistId', r.decklist_id
        ) order by r.tournament_date desc nulls last, r."placing" asc nulls last) as results
        from (
          select *
          from public.limitless_public_deck_results r
          where r.deck_id = d.deck_id
          order by r.tournament_date desc nulls last, r."placing" asc nulls last, r.player_name asc
          limit 4
        ) r
      ) results on true
      order by d.advisor_score desc, d.rank asc nulls last, d.points desc
    "#,
        &values,
    )
    .await?;
    let value = json!({
        "decks": rows.iter().map(deck_row_to_advisor_deck).collect::<Vec<_>>(),
    });
    let mut cache = match deck_advisor_cache().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(entry) = cache.iter_mut().find(|(key, _, _)| *key == cache_key) {
        entry.1 = Instant::now();
        entry.2 = value.clone();
    } else {
        cache.push((cache_key, Instant::now(), value.clone()));
    }
    while cache.len() > 25 {
        cache.remove(0);
    }
    Ok(value)
}

/// `deckAdvisorReply` -> {reply, actions}.
pub fn deck_advisor_reply(
    intent: &DeckAdvisorIntent,
    data: &Value,
    preferences: &Map<String, Value>,
) -> Value {
    let preference_language = preferences
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("");
    let italian = intent.language == "it" || preference_language == "it";
    let stored_decks = data
        .get("decks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let using_fallback = stored_decks.is_empty();
    let fallback = deck_advisor_fallback_decks(intent);
    let decks: Vec<Value> = if using_fallback {
        fallback
            .into_iter()
            .map(|(name, index)| {
                json!({
                    "deckId": "",
                    "name": name,
                    "rank": Value::Null,
                    "points": 0,
                    "share": 0,
                    "sourceUrl": "",
                    "coreCards": [],
                    "recentResults": [],
                    "fallback": true,
                    "index": index,
                })
            })
            .collect()
    } else {
        stored_decks
    };
    let lead = if decks.len() == 1 || !intent.deck_name.is_empty() {
        decks.first().cloned()
    } else {
        None
    };
    let render_deck = |deck: &Value, index: usize| {
        let name = deck.get("name").and_then(Value::as_str).unwrap_or("");
        let rank = deck.get("rank").and_then(Value::as_f64);
        let (plan, strengths, weaknesses, complexity, budget_tier) =
            deck_archetype_notes(name, intent);
        let core: Vec<String> = deck
            .get("coreCards")
            .and_then(Value::as_array)
            .map(|cards| {
                cards
                    .iter()
                    .take(4)
                    .filter_map(|card| card.get("name").and_then(Value::as_str))
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let first_result = deck
            .get("recentResults")
            .and_then(Value::as_array)
            .and_then(|results| results.first().cloned())
            .unwrap_or(Value::Null);
        let tournament_name = first_result
            .get("tournamentName")
            .and_then(Value::as_str)
            .unwrap_or("");
        let placing = first_result.get("placing").and_then(Value::as_f64);
        let source_url = deck.get("sourceUrl").and_then(Value::as_str).unwrap_or("");
        let source_line = if !tournament_name.is_empty() {
            match placing {
                Some(placing) => format!(
                    "Recent Limitless result: {tournament_name}, placing {}.",
                    super::text::js_number_to_string(placing)
                ),
                None => format!("Recent Limitless result: {tournament_name}."),
            }
        } else if !source_url.is_empty() {
            format!("Limitless source: {source_url}")
        } else {
            "No fresh local Limitless result row was available in this response.".to_owned()
        };
        [
            Some(format!(
                "{}. {}{}",
                index + 1,
                name,
                match rank {
                    Some(rank) if rank != 0.0 => {
                        format!(
                            " (Limitless rank {})",
                            super::text::js_number_to_string(rank)
                        )
                    }
                    _ => String::new(),
                }
            )),
            Some(format!("How it works: {plan}")),
            Some(format!("Strengths: {}", strengths.join(" "))),
            Some(format!("Weaknesses: {}", weaknesses.join(" "))),
            Some(format!(
                "Complexity: {complexity}. Budget tier: {budget_tier}."
            )),
            if core.is_empty() {
                None
            } else {
                Some(format!(
                    "Core cards seen in Limitless data: {}.",
                    core.join(", ")
                ))
            },
            Some(source_line),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n")
    };
    if intent.deck_name.is_empty()
        && !intent.beginner
        && !intent.budget
        && intent.playstyle.is_empty()
    {
        let rendered: Vec<String> = decks
            .iter()
            .take(3)
            .enumerate()
            .map(|(index, deck)| render_deck(deck, index))
            .collect();
        let reply = [
            if italian {
                "Posso aiutarti a scegliere, ma mi mancano i tuoi vincoli: budget, livello, stile (aggressivo/control), online o locale, e Pokémon preferiti."
            } else {
                "I can help you choose, but I need your constraints: budget, skill level, playstyle (aggressive/control), online or local, and favorite Pokémon."
            },
            if italian {
                "Intanto ti do 2-3 opzioni ragionevoli dai dati Limitless/site-data, con incertezza esplicita:"
            } else {
                "Meanwhile, here are 2-3 reasonable options from Limitless/site data, with clear uncertainty:"
            },
            rendered.join("\n\n").as_str(),
            if italian {
                "Non cito win rate esatti se non sono nel dato letto ora. La scelta finale va adattata al meta locale."
            } else {
                "I will not claim exact live win rates unless they are in the data read now. Tune the final choice to your local meta."
            },
        ]
        .join("\n\n");
        return json!({ "reply": reply, "actions": [] });
    }
    let rendered: Vec<String> = decks
        .iter()
        .take(if lead.is_some() { 1 } else { 3 })
        .enumerate()
        .map(|(index, deck)| render_deck(deck, index))
        .collect();
    let opening = match &lead {
        Some(lead) => {
            let name = lead.get("name").and_then(Value::as_str).unwrap_or("");
            if italian {
                format!("Per me il punto di partenza è {name}.")
            } else {
                format!("My starting pick is {name}.")
            }
        }
        None => {
            if italian {
                "Ecco le opzioni più sensate per quello che hai chiesto:".to_owned()
            } else {
                "Here are the strongest fits for what you asked:".to_owned()
            }
        }
    };
    let source = if italian {
        "Fonte: peer4/read-only Limitless public deck tables e dati site-data locali. Se serve meta live oltre al cache, Poko deve dirti quando sta usando dati pubblici esterni e con quale incertezza."
    } else {
        "Source: peer4/read-only Limitless public deck tables and local site data. If live meta beyond the cache is needed, Poko should say when public external data is used and how uncertain it is."
    };
    let reply = [opening, rendered.join("\n\n"), source.to_owned()].join("\n\n");
    json!({ "reply": reply, "actions": [] })
}

/// The six columns the card-path lookups project, with node-pg JSON types.
fn search_candidate_row(row: &sqlx::postgres::PgRow) -> Value {
    let row = JsRow(row);
    json!({
        "card_id": row.opt_i64("card_id").map(Value::from).unwrap_or(Value::Null),
        "card_name": row.opt_text("card_name").map(Value::String).unwrap_or(Value::Null),
        "set_name": row.opt_text("set_name").map(Value::String).unwrap_or(Value::Null),
        "collector_number": row.opt_text("collector_number").map(Value::String).unwrap_or(Value::Null),
        "rarity": row.opt_text("rarity").map(Value::String).unwrap_or(Value::Null),
        "canonical_path": row.opt_text("canonical_path").map(Value::String).unwrap_or(Value::Null),
    })
}

/// The `lookupByCardId` closure of `resolveCardQueryPath`.
async fn lookup_card_id_row(
    pool: &PgPool,
    id: String,
    language: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if id.is_empty() {
        return Ok(None);
    }
    let rows = query_rows(
        pool,
        r#"
          select
            marketplace_search_candidates.card_id,
            coalesce(
              nullif(marketplace_search_candidates.display_name, ''),
              nullif(marketplace_search_candidates.canonical_name, ''),
              marketplace_search_candidates.name
            ) as card_name,
            marketplace_search_candidates.set_name,
            marketplace_search_candidates.card_number as collector_number,
            marketplace_search_candidates.rarity,
            urls.canonical_path
          from public.marketplace_search_candidates
          left join public.marketplace_card_urls urls
            on urls.card_id = marketplace_search_candidates.card_id
          where marketplace_search_candidates.card_id::text = $1
          order by case when urls.language = $2 then 0 else 1 end
          limit 1
        "#,
        &[json!(id), json!(language)],
    )
    .await?;
    Ok(rows.first().map(search_candidate_row))
}

/// `resolveCardQueryPath`: cardId lookups then three name-based SQL fallbacks.
pub async fn resolve_card_query_path(
    pool: &PgPool,
    card: &Value,
    language: &str,
) -> Result<String, sqlx::Error> {
    let parts = crate::assistant::intent::parse_card_query_parts(card);
    if parts.card_id.is_empty() && (parts.query.is_empty() || parts.name.is_empty()) {
        return Ok(String::new());
    }
    let clean_language = {
        let part = slug_part(language);
        if part.is_empty() {
            "en".to_owned()
        } else {
            part
        }
    };
    if !parts.card_id.is_empty() {
        let exact = lookup_card_id_row(pool, parts.card_id.clone(), &clean_language).await?;
        if let Some(exact) = exact {
            if card_name_matches_hint_row(&exact, &parts.name) {
                let path =
                    canonical_marketplace_path(exact.as_object().unwrap_or(&Map::new()), language);
                if !path.is_empty() {
                    return Ok(path);
                }
            }
        }
        let doubled = crate::assistant::text::doubled_card_id(&parts.card_id);
        if !doubled.is_empty() && doubled != parts.card_id {
            let doubled_row = lookup_card_id_row(pool, doubled, &clean_language).await?;
            if let Some(doubled_row) = doubled_row {
                if card_name_matches_hint_row(&doubled_row, &parts.name) {
                    let path = canonical_marketplace_path(
                        doubled_row.as_object().unwrap_or(&Map::new()),
                        language,
                    );
                    if !path.is_empty() {
                        return Ok(path);
                    }
                }
            }
        }
    }
    let values = vec![
        json!(parts.name),
        json!(parts.collector_number),
        json!(parts.set_name),
        json!(parts.artist),
    ];
    let rows = query_rows(
        pool,
        r#"
      select
        marketplace_search_candidates.card_id,
        coalesce(
          nullif(marketplace_search_candidates.display_name, ''),
          nullif(marketplace_search_candidates.canonical_name, ''),
          marketplace_search_candidates.name
        ) as card_name,
        marketplace_search_candidates.set_name,
        marketplace_search_candidates.card_number as collector_number,
        marketplace_search_candidates.rarity,
        urls.canonical_path
      from public.marketplace_search_candidates
      left join public.marketplace_card_urls urls
        on urls.card_id = marketplace_search_candidates.card_id
      left join public.marketplace_blueprint_artists artists
        on artists.blueprint_id = marketplace_search_candidates.card_id
      where (
        lower(coalesce(
          nullif(marketplace_search_candidates.display_name, ''),
          nullif(marketplace_search_candidates.canonical_name, ''),
          marketplace_search_candidates.name
        )) = lower($1)
        or lower(marketplace_search_candidates.name) = lower($1)
        or lower(coalesce(marketplace_search_candidates.display_name, '')) = lower($1)
        or lower(coalesce(marketplace_search_candidates.canonical_name, '')) = lower($1)
      )
        and (
          $2::text = ''
          or lower(coalesce(marketplace_search_candidates.card_number, '')) = lower($2)
          or lower(coalesce(marketplace_search_candidates.card_number, '')) like '%' || lower($2) || '%'
          or ltrim(split_part(coalesce(marketplace_search_candidates.card_number, ''), '/', 1), '0') = ltrim(split_part($2::text, '/', 1), '0')
        )
        and (
          $3::text = ''
          or lower(coalesce(marketplace_search_candidates.set_name, '')) = lower($3)
          or lower(coalesce(marketplace_search_candidates.expansion_name, '')) = lower($3)
        )
      order by
        case
          when $4::text <> '' and lower(coalesce(artists.artist, artists.illustrator, '')) = lower($4) then 0
          else 1
        end,
        case
          when $3::text <> '' and lower(coalesce(marketplace_search_candidates.set_name, '')) = lower($3) then 0
          when $3::text <> '' and lower(coalesce(marketplace_search_candidates.expansion_name, '')) = lower($3) then 1
          else 2
        end,
        case
          when $2::text <> '' and lower(coalesce(marketplace_search_candidates.card_number, '')) = lower($2) then 0
          when $2::text <> '' and lower(coalesce(marketplace_search_candidates.card_number, '')) like '%' || lower($2) || '%' then 1
          when $2::text <> '' and ltrim(split_part(coalesce(marketplace_search_candidates.card_number, ''), '/', 1), '0') = ltrim(split_part($2::text, '/', 1), '0') then 2
          else 2
        end,
        marketplace_search_candidates.card_id desc
      limit 1
    "#,
        &values,
    )
    .await?;
    let mut row = rows.first().map(|row| {
        let row = JsRow(row);
        json!({
            "card_id": row.opt_i64("card_id").map(Value::from).unwrap_or(Value::Null),
            "card_name": row.opt_text("card_name").map(Value::String).unwrap_or(Value::Null),
            "set_name": row.opt_text("set_name").map(Value::String).unwrap_or(Value::Null),
            "collector_number": row.opt_text("collector_number").map(Value::String).unwrap_or(Value::Null),
            "rarity": row.opt_text("rarity").map(Value::String).unwrap_or(Value::Null),
            "canonical_path": row.opt_text("canonical_path").map(Value::String).unwrap_or(Value::Null),
        })
    });
    if row.is_none() && !parts.set_name.is_empty() {
        let rows = query_rows(
            pool,
            r#"
        select
          marketplace_search_candidates.card_id,
          coalesce(
            nullif(marketplace_search_candidates.display_name, ''),
            nullif(marketplace_search_candidates.canonical_name, ''),
            marketplace_search_candidates.name
          ) as card_name,
          marketplace_search_candidates.set_name,
          marketplace_search_candidates.card_number as collector_number,
          marketplace_search_candidates.rarity,
          urls.canonical_path
        from public.marketplace_search_candidates
        left join public.marketplace_card_urls urls
          on urls.card_id = marketplace_search_candidates.card_id
        left join public.marketplace_blueprint_artists artists
          on artists.blueprint_id = marketplace_search_candidates.card_id
        where (
          lower(coalesce(
            nullif(marketplace_search_candidates.display_name, ''),
            nullif(marketplace_search_candidates.canonical_name, ''),
            marketplace_search_candidates.name
          )) = lower($1)
          or lower(marketplace_search_candidates.name) = lower($1)
          or lower(coalesce(marketplace_search_candidates.display_name, '')) = lower($1)
          or lower(coalesce(marketplace_search_candidates.canonical_name, '')) = lower($1)
        )
          and (
            $2::text = ''
            or lower(coalesce(marketplace_search_candidates.card_number, '')) = lower($2)
            or lower(coalesce(marketplace_search_candidates.card_number, '')) like '%' || lower($2) || '%'
            or ltrim(split_part(coalesce(marketplace_search_candidates.card_number, ''), '/', 1), '0') = ltrim(split_part($2::text, '/', 1), '0')
          )
        order by
          case
            when $4::text <> '' and lower(coalesce(artists.artist, artists.illustrator, '')) = lower($4) then 0
            else 1
          end,
          case
            when $3::text <> '' and lower(coalesce(marketplace_search_candidates.set_name, '')) = lower($3) then 0
            when $3::text <> '' and lower(coalesce(marketplace_search_candidates.expansion_name, '')) = lower($3) then 1
            else 2
          end,
          case
            when $2::text <> '' and lower(coalesce(marketplace_search_candidates.card_number, '')) = lower($2) then 0
            when $2::text <> '' and lower(coalesce(marketplace_search_candidates.card_number, '')) like '%' || lower($2) || '%' then 1
            when $2::text <> '' and ltrim(split_part(coalesce(marketplace_search_candidates.card_number, ''), '/', 1), '0') = ltrim(split_part($2::text, '/', 1), '0') then 2
            else 2
          end,
          marketplace_search_candidates.card_id desc
        limit 1
      "#,
            &values,
        )
        .await?;
        row = rows.first().map(|row| {
            let row = JsRow(row);
            json!({
                "card_id": row.opt_i64("card_id").map(Value::from).unwrap_or(Value::Null),
                "card_name": row.opt_text("card_name").map(Value::String).unwrap_or(Value::Null),
                "set_name": row.opt_text("set_name").map(Value::String).unwrap_or(Value::Null),
                "collector_number": row.opt_text("collector_number").map(Value::String).unwrap_or(Value::Null),
                "rarity": row.opt_text("rarity").map(Value::String).unwrap_or(Value::Null),
                "canonical_path": row.opt_text("canonical_path").map(Value::String).unwrap_or(Value::Null),
            })
        });
    }
    if row.is_none() && !parts.collector_number.is_empty() {
        let rows = query_rows(
            pool,
            r#"
        select
          marketplace_search_candidates.card_id,
          coalesce(
            nullif(marketplace_search_candidates.display_name, ''),
            nullif(marketplace_search_candidates.canonical_name, ''),
            marketplace_search_candidates.name
          ) as card_name,
          marketplace_search_candidates.set_name,
          marketplace_search_candidates.card_number as collector_number,
          marketplace_search_candidates.rarity,
          urls.canonical_path
        from public.marketplace_search_candidates
        left join public.marketplace_card_urls urls
          on urls.card_id = marketplace_search_candidates.card_id
        left join public.marketplace_blueprint_artists artists
          on artists.blueprint_id = marketplace_search_candidates.card_id
        where lower(coalesce(
            nullif(marketplace_search_candidates.display_name, ''),
            nullif(marketplace_search_candidates.canonical_name, ''),
            marketplace_search_candidates.name,
            ''
          )) like '%' || lower($1) || '%'
          and (
            lower(coalesce(marketplace_search_candidates.card_number, '')) like '%' || lower($2) || '%'
            or lower(regexp_replace(coalesce(marketplace_search_candidates.card_number, ''), '^.*\\|\\s*', '')) like '%' || lower($2) || '%'
            or ltrim(split_part(regexp_replace(coalesce(marketplace_search_candidates.card_number, ''), '^.*\\|\\s*', ''), '/', 1), '0') = ltrim(split_part($2::text, '/', 1), '0')
          )
          and (
            $3::text = ''
            or lower(coalesce(marketplace_search_candidates.set_name, '')) = lower($3)
            or lower(coalesce(marketplace_search_candidates.expansion_name, '')) = lower($3)
          )
        order by
          case
            when $4::text <> '' and lower(coalesce(artists.artist, artists.illustrator, '')) = lower($4) then 0
            else 1
          end,
          case
            when $3::text <> '' and lower(coalesce(marketplace_search_candidates.set_name, '')) = lower($3) then 0
            when $3::text <> '' and lower(coalesce(marketplace_search_candidates.expansion_name, '')) = lower($3) then 1
            else 2
          end,
          case
            when lower(coalesce(
              nullif(marketplace_search_candidates.display_name, ''),
              nullif(marketplace_search_candidates.canonical_name, ''),
              marketplace_search_candidates.name,
              ''
            )) = lower($1) then 0
            when lower(coalesce(marketplace_search_candidates.card_number, '')) like '%' || lower($2) || '%' then 1
            else 2
          end,
          marketplace_search_candidates.card_id desc
        limit 1
      "#,
            &values,
        )
        .await?;
        row = rows.first().map(|row| {
            let row = JsRow(row);
            json!({
                "card_id": row.opt_i64("card_id").map(Value::from).unwrap_or(Value::Null),
                "card_name": row.opt_text("card_name").map(Value::String).unwrap_or(Value::Null),
                "set_name": row.opt_text("set_name").map(Value::String).unwrap_or(Value::Null),
                "collector_number": row.opt_text("collector_number").map(Value::String).unwrap_or(Value::Null),
                "rarity": row.opt_text("rarity").map(Value::String).unwrap_or(Value::Null),
                "canonical_path": row.opt_text("canonical_path").map(Value::String).unwrap_or(Value::Null),
            })
        });
    }
    match row {
        Some(row) => Ok(canonical_marketplace_path(
            row.as_object().unwrap_or(&Map::new()),
            language,
        )),
        None => Ok(String::new()),
    }
}

/// `cardNameMatchesHint` on a JSON row.
fn card_name_matches_hint_row(row: &Value, name_hint: &str) -> bool {
    let card_name = row.get("card_name").and_then(Value::as_str).unwrap_or("");
    crate::assistant::text::card_name_matches_hint(card_name, name_hint)
}

/// `pokoinSearchQueryFromLink`.
pub fn pokoin_search_query_from_link(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    let Some(url) = crate::assistant::context::url_with_base(text) else {
        return String::new();
    };
    let host = url.host_str().unwrap_or_default().to_lowercase();
    let internal_host = host == "pokoin.com" || host == "www.pokoin.com";
    let path = url.path().trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    if internal_host
        && (path == "/marketplace/search"
            || re("(?i)^/marketplace/[a-z]{2}/search$").is_match(path))
    {
        let query = url
            .query_pairs()
            .find(|(key, _)| key == "q")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default();
        return clean_text_str(&query, 160);
    }
    String::new()
}

/// `safeAssistantActions`.
pub fn safe_assistant_actions(actions: &Value) -> Vec<Value> {
    let Some(items) = actions.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|action| {
            let object = action.as_object()?;
            let type_value = crate::assistant::text::clean_text(
                &action
                    .get("type")
                    .or_else(|| action.get("action"))
                    .cloned()
                    .unwrap_or(Value::Null),
                40,
            )
            .to_lowercase();
            if type_value != "navigate" {
                return None;
            }
            let data = action.get("data").cloned().unwrap_or(Value::Null);
            let path = clean_internal_path(&or_value(
                &action.get("path").cloned().unwrap_or(Value::Null),
                &or_value(
                    &data.get("canonicalPath").cloned().unwrap_or(Value::Null),
                    &data.get("path").cloned().unwrap_or(Value::Null),
                ),
            ));
            if path.is_empty() {
                return None;
            }
            let mut safe = object.clone();
            safe.insert("type".into(), json!("navigate"));
            safe.insert("path".into(), json!(path));
            Some(Value::Object(safe))
        })
        .collect()
}

fn or_value(left: &Value, right: &Value) -> Value {
    let truthy = !matches!(left, Value::Null | Value::Bool(false))
        && !matches!(left, Value::String(text) if text.is_empty())
        && !matches!(left, Value::Number(number) if number.as_f64() == Some(0.0));
    if truthy {
        left.clone()
    } else {
        right.clone()
    }
}

/// `shouldRewriteCardSuggestionLinks`.
pub fn should_rewrite_card_suggestion_links(delivery: &Value) -> bool {
    if !delivery.is_object() {
        return false;
    }
    let intent = clean_text(delivery.get("intent").unwrap_or(&Value::Null), 80).to_lowercase();
    if intent == "card" {
        return true;
    }
    let reply = clean_text(delivery.get("reply").unwrap_or(&Value::Null), 5000);
    if re("(?i)(?-u:\\b)(my illustration pick|card taste mode|cute card|recommend(?:ed)? card|suggest(?:ed)? card)(?-u:\\b)")
        .is_match(&reply)
        && re("(?i)marketplace/(?:[a-z]{2}/)?search\\?").is_match(&reply)
    {
        return true;
    }
    let Some(actions) = delivery.get("actions").and_then(Value::as_array) else {
        return false;
    };
    actions.iter().any(|action| {
        let object = match action.as_object() {
            Some(object) => object,
            None => return false,
        };
        let reason = clean_text(object.get("reason").unwrap_or(&Value::Null), 80).to_lowercase();
        let label = clean_text(object.get("label").unwrap_or(&Value::Null), 120).to_lowercase();
        let data = object.get("data").cloned().unwrap_or(Value::Null);
        let from_path = pokoin_search_query_from_link(
            &object.get("path").and_then(Value::as_str).unwrap_or(""),
        );
        let query = if from_path.is_empty() {
            let from_data = data.get("query").cloned().unwrap_or(Value::Null);
            let from_action = object.get("query").cloned().unwrap_or(Value::Null);
            clean_text(&or_value(&from_data, &from_action), 160)
        } else {
            from_path
        };
        (reason.contains("card_suggestion")
            || label.starts_with("search ")
            || label.starts_with("open "))
            && !crate::assistant::intent::parse_card_query_parts(&json!(query))
                .collector_number
                .is_empty()
    })
}

/// `rewriteCardSuggestionLinks`.
pub async fn rewrite_card_suggestion_links(
    pool: &PgPool,
    delivery: &Value,
    page: &str,
) -> Result<Value, sqlx::Error> {
    if !should_rewrite_card_suggestion_links(delivery) {
        return Ok(delivery.clone());
    }
    let language = crate::assistant::context::marketplace_language_from_page(page);
    let reply = clean_text(delivery.get("reply").unwrap_or(&Value::Null), 5000);
    let url_matches: Vec<String> = re(r"https?://[^\s)]+")
        .find_iter(&reply)
        .map(|part| part.as_str().to_owned())
        .collect();
    let mut replacements: Vec<(String, String)> = Vec::new();
    let mut resolved_paths: Vec<String> = Vec::new();
    let mut resolved_by_query: Vec<(String, String)> = Vec::new();
    let actions_value = delivery.get("actions").cloned().unwrap_or(Value::Null);
    // Collect the unique queries the JS `resolveQuery` helper would memoize.
    let mut pending_queries: Vec<String> = Vec::new();
    let enqueue = |query: &str, pending: &mut Vec<String>| {
        let clean_query = clean_text_str(query, 160);
        if clean_query.is_empty() || pending.contains(&clean_query) {
            return;
        }
        pending.push(clean_query);
    };
    for raw_url in &url_matches {
        enqueue(
            &pokoin_search_query_from_link(raw_url),
            &mut pending_queries,
        );
    }
    if let Some(actions) = actions_value.as_array() {
        for action in actions {
            let Some(object) = action.as_object() else {
                continue;
            };
            let data = object.get("data").cloned().unwrap_or(Value::Null);
            let from_path = pokoin_search_query_from_link(
                &object.get("path").and_then(Value::as_str).unwrap_or(""),
            );
            let query = if from_path.is_empty() {
                or_value(
                    &data.get("query").cloned().unwrap_or(Value::Null),
                    &object.get("query").cloned().unwrap_or(Value::Null),
                )
            } else {
                json!(from_path)
            };
            enqueue(&clean_text(&query, 160), &mut pending_queries);
        }
    }
    for query in &pending_queries {
        let path = resolve_card_query_path(pool, &json!(query), &language)
            .await
            .unwrap_or_default();
        resolved_by_query.push((query.clone(), path));
    }
    for raw_url in &url_matches {
        let query = pokoin_search_query_from_link(raw_url);
        let clean_query = clean_text_str(&query, 160);
        if clean_query.is_empty() {
            continue;
        }
        if let Some((_, path)) = resolved_by_query
            .iter()
            .find(|(key, _)| *key == clean_query)
        {
            if !path.is_empty() {
                if !replacements.iter().any(|(from, _)| from == raw_url) {
                    replacements.push((raw_url.clone(), format!("https://pokoin.com{path}")));
                }
                resolved_paths.push(path.clone());
            }
        }
    }
    let mut actions: Vec<Value> = Vec::new();
    if let Some(items) = actions_value.as_array() {
        for action in items {
            if !action.is_object() {
                actions.push(action.clone());
                continue;
            }
            let object = action.as_object().expect("checked object");
            let data = object.get("data").cloned().unwrap_or(Value::Null);
            let from_path = pokoin_search_query_from_link(
                &object.get("path").and_then(Value::as_str).unwrap_or(""),
            );
            let query = if from_path.is_empty() {
                or_value(
                    &data.get("query").cloned().unwrap_or(Value::Null),
                    &object.get("query").cloned().unwrap_or(Value::Null),
                )
            } else {
                json!(from_path)
            };
            let clean_query = clean_text(&query, 160);
            let path = if clean_query.is_empty() {
                String::new()
            } else {
                resolved_by_query
                    .iter()
                    .find(|(key, _)| *key == clean_query)
                    .map(|(_, path)| path.clone())
                    .unwrap_or_default()
            };
            if path.is_empty() {
                actions.push(action.clone());
                continue;
            }
            let mut rewritten = object.clone();
            rewritten.insert("path".into(), json!(path));
            let label = object.get("label").and_then(Value::as_str).unwrap_or("");
            let label = {
                let replaced = re("(?i)^Search(?-u:\\b)")
                    .replace(label, "Open")
                    .into_owned();
                if replaced.is_empty() {
                    "Open card".to_owned()
                } else {
                    replaced
                }
            };
            rewritten.insert("label".into(), json!(label));
            let mut data_object = data.as_object().cloned().unwrap_or_default();
            data_object.insert("canonicalPath".into(), json!(path));
            rewritten.insert("data".into(), Value::Object(data_object));
            actions.push(Value::Object(rewritten));
        }
    }
    let has_navigate_action = actions.iter().any(|action| {
        action.get("type").and_then(Value::as_str) == Some("navigate")
            && clean_text(action.get("path").unwrap_or(&Value::Null), 500).starts_with('/')
    });
    if !has_navigate_action && !resolved_paths.is_empty() {
        actions.push(json!({
            "type": "navigate",
            "path": resolved_paths[0],
            "label": "Open card",
            "reason": "card_suggestion_link",
            "data": { "canonicalPath": resolved_paths[0] },
        }));
    }
    let mut rewritten_reply = reply;
    for (from, to) in &replacements {
        rewritten_reply = rewritten_reply.replace(from, to);
    }
    let rewritten_reply = re(r"(?-u:\b)(?:Open|Search) it on Pokoin:\s*")
        .replace_all(&rewritten_reply, "")
        .into_owned();
    let mut rewritten = delivery.as_object().cloned().unwrap_or_default();
    rewritten.insert("reply".into(), json!(rewritten_reply));
    rewritten.insert("actions".into(), Value::Array(actions));
    Ok(Value::Object(rewritten))
}

/// `resolveThemedCardPick`.
pub async fn resolve_themed_card_pick<'a>(
    pool: &PgPool,
    theme: Option<&'a crate::assistant::intent::CardSuggestionTheme>,
    language: &str,
) -> (Option<&'a crate::assistant::intent::ThemePick>, String) {
    let Some(theme) = theme else {
        return (None, String::new());
    };
    for pick in &theme.picks {
        let direct_path = resolve_card_query_path(pool, &json!(pick.query), language)
            .await
            .unwrap_or_default();
        if !direct_path.is_empty() {
            return (Some(pick), direct_path);
        }
    }
    (theme.picks.first(), String::new())
}

/// `cardSuggestion` — the random/theme card suggestion delivery.
pub async fn card_suggestion(
    pool: &PgPool,
    page: &str,
    message: &str,
    chat_record: &[(String, String)],
) -> Value {
    const PICKS: [(&str, &str, &str, &str, &str, &str); 5] = [
        (
            "Magikarp",
            "Magikarp 203/193",
            "497712",
            "Paldea Evolved",
            "Shinji Kanda",
            "a wild vertical waterfall scene where tiny Magikarp feels heroic instead of silly",
        ),
        (
            "Dragonite V",
            "Dragonite V 192/203",
            "332860",
            "Evolving Skies",
            "Atsushi Furusawa",
            "soft flying-postman energy, with Dragonite drifting above the sea like a friendly guardian",
        ),
        (
            "Drowzee",
            "Drowzee 210/198",
            "483348",
            "Scarlet & Violet",
            "Tomokazu Komiya",
            "a dreamy, strange city scene that feels hand-drawn and full of personality",
        ),
        (
            "Mew ex",
            "Mew ex 232/091",
            "548832",
            "Paldean Fates",
            "USGMEN",
            "a playful bubblegum-pink illustration packed with tiny cute details around Mew",
        ),
        (
            "Poliwhirl",
            "Poliwhirl 176/165",
            "502864",
            "Pokémon Card 151",
            "Gemi",
            "a quiet rainy-street mood, perfect if you like cozy illustration cards",
        ),
    ];
    let language = crate::assistant::context::marketplace_language_from_page(page);
    let theme = crate::assistant::intent::detect_card_suggestion_theme(message, chat_record);
    let (themed_pick, themed_path) = resolve_themed_card_pick(pool, theme, language.as_str()).await;
    // Themed picks carry no artist, so the JS reply prints `by undefined` and
    // the action data omits the artist key (JSON.stringify drops undefined).
    let (pick_name, pick_query, pick_detail, pick_artist): (&str, &str, &str, Option<&str>) =
        match themed_pick {
            Some(pick) => (pick.name, pick.query, pick.detail, None),
            None => {
                let index = rand::random::<usize>() % PICKS.len();
                let pick = PICKS[index];
                (pick.0, pick.1, pick.5, Some(pick.4))
            }
        };
    let direct_path = if !themed_path.is_empty() {
        themed_path
    } else {
        resolve_card_query_path(pool, &json!(pick_query), &language)
            .await
            .unwrap_or_default()
    };
    let target_path = if direct_path.is_empty() {
        crate::assistant::context::card_search_path(pick_query)
    } else {
        direct_path.clone()
    };
    let target_label = if !direct_path.is_empty() {
        format!("Open {pick_name}")
    } else {
        format!("Search {pick_name}")
    };
    let theme_line = match theme {
        Some(theme) => format!(
            "Theme match: you asked for {}, so I picked {} instead of a random cute card.",
            theme.label, pick_name
        ),
        None => "Poko card taste mode activated ⭐💛".to_owned(),
    };
    let mut data = Map::new();
    data.insert("query".into(), json!(pick_query));
    if let Some(artist) = pick_artist {
        data.insert("artist".into(), json!(artist));
    }
    data.insert(
        "theme".into(),
        json!(theme.map(|theme| theme.id).unwrap_or("")),
    );
    data.insert("direct".into(), json!(!direct_path.is_empty()));
    let reply = [
        theme_line,
        String::new(),
        "This is not financial advice. I only judge by cuteness, personality, and “would I put it in a cozy binder?” energy. 😊".to_owned(),
        String::new(),
        format!(
            "My illustration pick: {} by {}.",
            pick_name,
            pick_artist.unwrap_or("undefined")
        ),
        format!("Why I like it: {pick_detail}."),
        String::new(),
        format!("https://pokoin.com{target_path}"),
        String::new(),
        "If you want a theme, try collecting by vibe: ocean cuties, electric babies, sleepy cards, tiny legends, or cards with cozy backgrounds. Much healthier than chasing price candles 📚✨".to_owned(),
    ]
    .join("\n");
    json!({
        "reply": reply,
        "actions": [{
            "type": "navigate",
            "path": target_path,
            "label": target_label,
            "reason": match theme {
                Some(theme) => format!("themed_card_suggestion:{}", theme.id),
                None => "cute_card_suggestion".to_owned(),
            },
            "data": Value::Object(data),
        }],
    })
}

/// `cardDetailsLine`.
pub fn card_details_line(card: &Value, marketplace_card: Option<&Value>, italian: bool) -> String {
    let get = |key: &str| card.get(key).and_then(Value::as_str).unwrap_or("");
    let mut details: Vec<String> = Vec::new();
    let set_name = get("setName");
    if !set_name.is_empty() {
        details.push(if italian {
            format!("set {set_name}")
        } else {
            format!("set {set_name}")
        });
    }
    let collector = get("collectorNumber");
    if !collector.is_empty() {
        details.push(if italian {
            format!("numero {collector}")
        } else {
            format!("number {collector}")
        });
    }
    let rarity = get("rarity");
    if !rarity.is_empty() {
        details.push(rarity.to_owned());
    }
    let artist = get("artist");
    if !artist.is_empty() {
        details.push(if italian {
            format!("artista {artist}")
        } else {
            format!("artist {artist}")
        });
    }
    let details = details.join(", ");
    let floor_price = marketplace_card
        .and_then(|card| card.get("floorPricePkn"))
        .and_then(Value::as_f64)
        .or_else(|| card.get("pricePkn").and_then(Value::as_f64));
    let listing_text = match floor_price {
        Some(price) if price != 0.0 => {
            if italian {
                format!(
                    "Prezzo floor/indicativo disponibile: {} PKN.",
                    format_pkn(price)
                )
            } else {
                format!(
                    "Available floor/indicative price: {} PKN.",
                    format_pkn(price)
                )
            }
        }
        Some(_) | None => {
            if italian {
                "Non vedo un floor price affidabile in questo momento.".to_owned()
            } else {
                "I do not see a reliable floor price right now.".to_owned()
            }
        }
    };
    let active = marketplace_card
        .and_then(|card| card.get("activeListingCount"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let supply_text = if active != 0.0 {
        if italian {
            format!(
                "Listing attivi: {}.",
                super::text::js_number_to_string(active)
            )
        } else {
            format!(
                "Active listings: {}.",
                super::text::js_number_to_string(active)
            )
        }
    } else {
        String::new()
    };
    [
        if details.is_empty() {
            None
        } else if italian {
            Some(format!("Contesto: {details}."))
        } else {
            Some(format!("Context: {details}."))
        },
        Some(listing_text),
        if supply_text.is_empty() {
            None
        } else {
            Some(supply_text)
        },
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
}

/// `communitySentimentLine` — `sentiment` is {available, limited, signal}.
pub fn community_sentiment_line(sentiment: &Value, italian: bool) -> String {
    let available = sentiment
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !available {
        return if italian {
            "Sul sentiment collezionistico online ho segnali limitati in questo momento, quindi mi baso soprattutto sui dati della carta e del marketplace.".to_owned()
        } else {
            "Online collector sentiment is limited right now, so I am leaning mostly on the card and marketplace context.".to_owned()
        };
    }
    let signal = sentiment
        .get("signal")
        .and_then(Value::as_str)
        .unwrap_or("");
    if signal == "positive_collecting" {
        return if italian {
            "Nel sentiment collezionistico online emergono soprattutto apprezzamento per artwork e appeal da binder, più che certezze da investimento.".to_owned()
        } else {
            "Across online collector sentiment, the stronger signal is artwork and binder appeal rather than any sure investment case.".to_owned()
        };
    }
    if signal == "cautious_price" {
        return if italian {
            "Nel sentiment collezionistico online emerge anche cautela sul prezzo: meglio ragionare su entry price, condizione e liquidità.".to_owned()
        } else {
            "Across online collector sentiment, there is also price caution, so entry price, condition, and liquidity matter a lot.".to_owned()
        };
    }
    if italian {
        "Tra i collezionisti il segnale sembra misto/leggero: buona carta da valutare per gusto e prezzo d’ingresso, non per aspettative garantite.".to_owned()
    } else {
        "Among collectors the signal looks mixed or light: worth judging by taste and entry price, not by guaranteed upside.".to_owned()
    }
}

/// `contextualCardOpinionReply`.
pub fn contextual_card_opinion_reply(
    card: &Value,
    marketplace_card: Option<&Value>,
    sentiment: &Value,
    italian: bool,
) -> String {
    let card_get = |key: &str| card.get(key).and_then(Value::as_str).unwrap_or("");
    let market_get = |key: &str| {
        marketplace_card
            .and_then(|card| card.get(key))
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    let title = {
        let card_title = card_get("title");
        if !card_title.is_empty() {
            card_title
        } else {
            market_get("name")
        }
    };
    let set_name = {
        let card_set = card_get("setName");
        if !card_set.is_empty() {
            card_set
        } else {
            market_get("setName")
        }
    };
    let collector = {
        let card_collector = card_get("collectorNumber");
        if !card_collector.is_empty() {
            card_collector
        } else {
            market_get("collectorNumber")
        }
    };
    let rarity = {
        let card_rarity = card_get("rarity");
        if !card_rarity.is_empty() {
            card_rarity
        } else {
            market_get("rarity")
        }
    };
    let name =
        crate::assistant::intent::current_card_display_name(title, set_name, collector, rarity);
    if italian {
        [
            format!("Su {name}: la vedrei più come carta da collezione forte che come “investimento” puro."),
            "Non è consulenza finanziaria: sulle Pokémon card eviterei previsioni secche e guarderei prezzo d’ingresso, condizione, liquidità e quanto ti piace davvero tenerla.".to_owned(),
            card_details_line(card, marketplace_card, true),
            community_sentiment_line(sentiment, true),
            "Per me il ragionamento pratico è: se la prendi in buona condizione, a un prezzo vicino ai comparabili venduti/floor realistico, e ti piace l’artwork, ha senso. Se la compri solo sperando che salga, starei più cauto.".to_owned(),
        ]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    } else {
        [
            format!("On {name}: I would treat it more as a strong collector card than a pure “investment”."),
            "Not financial advice: with Pokémon cards I would avoid hard price predictions and focus on entry price, condition, liquidity, and whether you actually want to hold it.".to_owned(),
            card_details_line(card, marketplace_card, false),
            community_sentiment_line(sentiment, false),
            "My practical take: if the copy is clean, priced close to real sold comps or a realistic floor, and you like the artwork, it can make sense. If the only reason is guaranteed upside, I would be more cautious.".to_owned(),
        ]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    }
}

/// `normalizeIntentText` re-export for sibling modules.
pub fn normalized(value: &str) -> String {
    normalize_intent_text(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubled_and_canonical_paths() {
        let row = json!({
            "canonical_path": "/marketplace/en/cards/248856/charizard-base-set",
        })
        .as_object()
        .cloned()
        .unwrap();
        assert_eq!(
            canonical_marketplace_path(&row, "it"),
            "/marketplace/it/cards/248856/charizard-base-set"
        );
        assert_eq!(
            canonical_marketplace_path(&row, "en"),
            "/marketplace/en/cards/248856/charizard-base-set"
        );
        // Invalid canonical path falls back to the slug builder.
        let fallback = json!({
            "card_id": "248856",
            "card_name": "Charizard",
            "collector_number": "4/102",
            "set_name": "Base Set",
            "rarity": "Rare Holo",
        })
        .as_object()
        .cloned()
        .unwrap();
        assert_eq!(
            canonical_marketplace_path(&fallback, "en"),
            "/marketplace/en/cards/248856/rare-holo-charizard-4-102-base-set"
        );
    }

    #[test]
    fn no_data_replies_reference_sources() {
        let listing = json!({"type": "active_listing", "query": "pikachu", "cardId": ""});
        assert!(no_data_marketplace_reply(&listing).contains("marketplace_user_listings"));
        let analytics = json!({"type": "analytics", "query": "", "cardId": "42"});
        let reply = no_data_marketplace_reply(&analytics);
        assert!(reply.contains("42"));
        assert!(reply.contains("marketplace_hot_blueprints"));
        let lookup = json!({"type": "card_lookup", "query": "", "cardId": ""});
        assert!(no_data_marketplace_reply(&lookup).contains("that card"));
    }

    #[test]
    fn grounded_reply_without_listing_offers_card_match() {
        let grounding = json!({
            "type": "active_listing",
            "mode": "floor",
            "query": "pikachu",
            "cardId": "",
            "listing": Value::Null,
            "cards": [{
                "cardId": "248856",
                "name": "Pikachu",
                "setName": "Base Set",
                "collectorNumber": "58/102",
                "rarity": "",
                "path": "/marketplace/en/cards/248856/x",
                "url": "https://pokoin.com/marketplace/en/cards/248856/x",
                "activeListingCount": 2,
                "listedQuantity": 2,
                "floorPricePkn": 12.5,
                "hotScore24h": 0,
                "views24h": 0,
                "searches24h": 0,
                "clicks24h": 0,
            }],
        });
        let reply = grounded_marketplace_reply(&grounding, "en");
        assert!(reply["reply"]
            .as_str()
            .unwrap()
            .contains("I did find a matching card page"));
        assert_eq!(
            reply["actions"][0]["reason"],
            json!("marketplace_no_listing_card_match")
        );
    }

    #[test]
    fn grounded_listing_reply_composes_details() {
        let grounding = json!({
            "type": "active_listing",
            "mode": "highest",
            "query": "pikachu",
            "cardId": "",
            "listing": {
                "listing_id": "abc-123",
                "card_id": "248856",
                "card_name": "Charizard",
                "price_pkn": 1234.5,
                "quantity_available": 1,
                "condition": "NM",
                "language": "EN",
                "foil_state": null,
                "graded": false,
                "grade": null,
                "seller_name": "gio",
                "set_name": "Base Set",
                "collector_number": "4/102",
                "name": "Charizard",
                "rarity": "Rare Holo",
                "canonical_path": "/marketplace/en/cards/248856/charizard",
                "lowest_ask_pkn": "999.99",
                "active_listing_count": 3,
                "listed_quantity": 5,
                "views_24h": 1,
                "searches_24h": 2,
                "clicks_24h": 3,
                "hot_score_24h": "7.5",
            },
            "cards": [],
        });
        let reply = grounded_marketplace_reply(&grounding, "en");
        let text = reply["reply"].as_str().unwrap();
        assert!(text.contains("highest-priced active listing I found is Charizard at 1,234.5 PKN"));
        assert!(text.contains("condition NM, language EN, quantity 1, seller gio"));
        assert!(text.contains("https://pokoin.com/marketplace/en/cards/248856/charizard"));
        let action = &reply["actions"][0];
        assert_eq!(action["label"], json!("Open Charizard"));
        assert_eq!(action["data"]["pricePkn"], json!(1234.5));
        assert_eq!(action["data"]["listingId"], json!("abc-123"));
    }

    #[test]
    fn analytics_reply_lists_top_cards() {
        let grounding = json!({
            "type": "analytics",
            "mode": "hot",
            "query": "pikachu",
            "cardId": "",
            "cards": [{
                "cardId": "1",
                "name": "Pikachu",
                "setName": "Base Set",
                "collectorNumber": "58/102",
                "rarity": "",
                "path": "/marketplace/en/cards/1/x",
                "url": "https://pokoin.com/marketplace/en/cards/1/x",
                "activeListingCount": 1,
                "listedQuantity": 1,
                "floorPricePkn": Value::Null,
                "hotScore24h": 12.5,
                "views24h": 100,
                "searches24h": 20,
                "clicks24h": 3,
            }],
        });
        let reply = grounded_marketplace_reply(&grounding, "en");
        let text = reply["reply"].as_str().unwrap();
        assert!(text.contains("I checked Pokoin marketplace analytics for pikachu."));
        assert!(text.contains("1. Pikachu (Base Set): hot score 12.5, 100 views, 20 searches, 3 clicks in 24h, no active floor price"));
        assert_eq!(
            reply["actions"][0]["reason"],
            json!("marketplace_hot_blueprint")
        );
    }

    #[test]
    fn recommendation_reply_uses_floor_then_partner_price() {
        let intent = json!({"subject": "vanillite", "themeId": "", "themeLabel": "", "styles": [], "budget": "", "explicitSubject": true});
        let card = json!({
            "cardId": "1",
            "name": "Vanillite",
            "setName": "Boundaries Crossed",
            "collectorNumber": "34/149",
            "rarity": "",
            "path": "/marketplace/en/cards/1/x",
            "url": "https://pokoin.com/marketplace/en/cards/1/x",
            "activeListingCount": 2,
            "listedQuantity": 2,
            "floorPricePkn": Value::Null,
            "hotScore24h": 0,
            "views24h": 0,
            "searches24h": 0,
            "clicks24h": 0,
            "score": 620,
            "artist": "Kanako Eo",
            "types": ["Water"],
            "flavorText": "",
            "cardtraderCheapestPkn": 3.25,
            "cardtraderEligibleListings": 4,
            "sales24h": 1,
            "cartAdds24h": 2,
        });
        let reply = recommendation_reply(&intent, &[card], "en", &Map::new());
        let text = reply["reply"].as_str().unwrap();
        assert!(text.contains("I am opening Vanillite (Boundaries Crossed) 34/149."));
        assert!(text.contains("I prioritized your explicit subject first: vanillite."));
        assert!(text.contains("Indicative floor/price: 3.25 PKN."));
        assert!(text.contains("Artist: Kanako Eo."));
        assert_eq!(
            reply["actions"][0]["data"]["recommendationScore"],
            json!(620)
        );
    }

    #[test]
    fn deck_advisor_reply_fallback_and_lead() {
        let intent =
            crate::assistant::intent::deck_advisor_intent_from_message("best charizard deck", &[])
                .unwrap();
        let data = json!({"decks": []});
        let reply = deck_advisor_reply(&intent, &data, &Map::new());
        let text = reply["reply"].as_str().unwrap();
        // The fallback deck list is literally `[intent.deckName]`.
        assert!(text.contains("My starting pick is charizard."));
        assert!(text.contains("How it works: Charizard ex decks usually ramp Fire energy"));
        let generic_intent =
            crate::assistant::intent::deck_advisor_intent_from_message("recommend a deck", &[])
                .unwrap();
        let generic_reply = deck_advisor_reply(&generic_intent, &json!({"decks": []}), &Map::new());
        assert!(generic_reply["reply"]
            .as_str()
            .unwrap()
            .contains("I need your constraints"));
    }

    #[test]
    fn pokoin_search_links_are_peeled() {
        assert_eq!(
            pokoin_search_query_from_link("https://pokoin.com/marketplace/search?q=charizard%20ex"),
            "charizard ex"
        );
        assert_eq!(
            pokoin_search_query_from_link("https://pokoin.com/marketplace/it/search?q=mew"),
            "mew"
        );
        assert_eq!(pokoin_search_query_from_link("https://pokoin.com/docs"), "");
        assert_eq!(
            pokoin_search_query_from_link("https://evil.com/marketplace/search?q=x"),
            ""
        );
    }

    #[test]
    fn safe_actions_filter_navigates_only() {
        let actions = json!([
            {"type": "navigate", "path": "/marketplace/en/cards/1/x", "label": "Open"},
            {"type": "scroll", "path": "/x"},
            {"type": "navigate", "path": "https://evil.com"},
            {"action": "navigate", "data": {"canonicalPath": "/cart"}},
            "junk"
        ]);
        let safe = safe_assistant_actions(&actions);
        assert_eq!(safe.len(), 2);
        assert_eq!(safe[0]["path"], json!("/marketplace/en/cards/1/x"));
        assert_eq!(safe[1]["path"], json!("/cart"));
        assert_eq!(safe[1]["type"], json!("navigate"));
    }

    #[test]
    fn should_rewrite_detection() {
        assert!(should_rewrite_card_suggestion_links(
            &json!({"intent": "card", "reply": "", "actions": []})
        ));
        assert!(should_rewrite_card_suggestion_links(&json!({
            "intent": "marketplace",
            "reply": "My illustration pick: Mew. https://pokoin.com/marketplace/search?q=mew+ex",
            "actions": []
        })));
        assert!(should_rewrite_card_suggestion_links(&json!({
            "intent": "marketplace",
            "reply": "",
            "actions": [{"type": "navigate", "path": "/marketplace/search?q=pikachu%2058/102", "reason": "card_suggestion_link"}]
        })));
        assert!(!should_rewrite_card_suggestion_links(
            &json!({"intent": "marketplace", "reply": "plain", "actions": []})
        ));
    }

    #[test]
    fn sentiment_lines_by_signal() {
        assert!(community_sentiment_line(
            &json!({"available": false, "limited": true, "signal": ""}),
            true
        )
        .contains("segnali limitati"));
        assert!(community_sentiment_line(
            &json!({"available": true, "limited": false, "signal": "positive_collecting"}),
            false
        )
        .contains("artwork and binder appeal"));
        assert!(community_sentiment_line(
            &json!({"available": true, "limited": false, "signal": "cautious_price"}),
            false
        )
        .contains("price caution"));
        assert!(community_sentiment_line(
            &json!({"available": true, "limited": false, "signal": "mixed_or_light"}),
            false
        )
        .contains("mixed or light"));
    }

    #[test]
    fn card_details_line_formats() {
        let card = json!({"setName": "Base Set", "collectorNumber": "4/102", "rarity": "Rare Holo", "artist": "Mitsuhiro Arita", "pricePkn": 12.5});
        let line = card_details_line(&card, None, false);
        assert!(line
            .contains("Context: set Base Set, number 4/102, Rare Holo, artist Mitsuhiro Arita."));
        assert!(line.contains("Available floor/indicative price: 12.5 PKN."));
        let market = json!({"floorPricePkn": 7.0, "activeListingCount": 3});
        let line = card_details_line(&json!({"setName": "Base Set"}), Some(&market), true);
        assert!(line.contains("Prezzo floor/indicativo disponibile: 7 PKN."));
        assert!(line.contains("Listing attivi: 3."));
    }

    #[test]
    fn contextual_opinion_reply() {
        let card = json!({"title": "Charizard", "setName": "Base Set", "collectorNumber": "4/102", "rarity": "", "artist": ""});
        let sentiment = json!({"available": false, "limited": true, "signal": ""});
        let reply = contextual_card_opinion_reply(&card, None, &sentiment, false);
        assert!(reply.starts_with("On Charizard Base Set 4/102:"));
        assert!(reply.contains("Not financial advice"));
    }
}
