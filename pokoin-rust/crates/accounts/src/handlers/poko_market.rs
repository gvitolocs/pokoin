//! `poko-market` — the service-token marketplace tool API.
//!
//! One POST with a `tool` field dispatches through a `TOOLS` table to fifteen
//! analytics tools for Poko. All the decision maths lives in
//! [`crate::domain::poko_market_math`]; this module owns the SQL, the price
//! history readers and the HTTP plumbing.
//!
//! Every tool answers with `{ ok: true, tool, today, status, … }`, and the HTTP
//! status follows the tool's own `status`: `invalid` is a 400, `not_found` a
//! 404, `ambiguous` a 200, `unsupported` a 422. A thrown query is a 500 with a
//! generic message; the tool's own detail never leaks as a 500.

use std::collections::HashMap;
use std::sync::OnceLock;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use regex::Regex;
use serde_json::{json, Map, Value as Json};

use crate::domain::poko_market_math::{
    ask_history_from_source, candidate_from_row, clean_text,
    day_of, days_ago_iso, deal_verdict, dedupe_artwork_versions,
    escape_like, facet_label, fuzzy_artist_pattern, js_num, liquidity_bands, normalize_condition,
    normalize_language, price_strategies, resolve_facet, round2,
    round2_or_none, sold_by_condition_language, sold_estimate_from_stats, sold_facet_from_params,
    sold_flag, sold_stats, summarize_live_asks, today_iso, variants_sold,
    Facet, MAX_COLLECTION_CARDS, MOVERS_MAX_CANDIDATES, MOVERS_MIN_PRICE_PKN, PKN_EUR_RATE,
    RECENT_SALE_VERIFY_RATIO, SOLD_HIGH_VALUE_MAX_TO_ASK, SOLD_HIGH_VALUE_PKN,
    SOLD_REFERENCE_ASK_DAYS, SOLD_ROWS_LIMIT, SOLD_UNVERIFIED_MAX_PKN, TOP_SELLERS_MAX_SOLD_TO_ASK,
};
use crate::error::{ApiError, Result};
use crate::sql::{row_text, MarketplaceDb, SqlParam};
use crate::state::DomainState;

use super::{json_with_cors, parse_body, string_field};

/// Everything a tool needs.
pub struct MarketDeps {
    pub db: MarketplaceDb,
    /// The TCGplayer history database (`TCGCSV_DATABASE_URL`), when configured.
    pub tcg: Option<MarketplaceDb>,
    pub game: String,
    pub now_ms: i64,
}

impl MarketDeps {
    fn today(&self) -> String {
        today_iso(self.now_ms)
    }

    fn days_ago(&self, days: i64) -> String {
        days_ago_iso(self.now_ms, days)
    }
}

/// `queryRows(text, values)`.
async fn query_rows(db: &MarketplaceDb, sql: &str, params: &[SqlParam]) -> Result<Vec<Json>> {
    db.query_json(sql, params).await.map_err(ApiError::from)
}

fn param_string(params: &Json, key: &str, max: usize) -> String {
    clean_text(&string_field(params, key), max)
}

fn param_number(params: &Json, key: &str) -> Option<f64> {
    params.get(key).and_then(|value| match value {
        Json::Number(number) => number.as_f64(),
        Json::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    })
}

/// `Math.min(Math.max(Number(x) || fallback, low), high)`.
fn bounded(params: &Json, key: &str, fallback: f64, low: f64, high: f64) -> f64 {
    let raw = param_number(params, key).unwrap_or(0.0);
    let value = if raw == 0.0 { fallback } else { raw };
    value.max(low).min(high)
}

fn field_str(row: &Json, key: &str) -> String {
    row_text(row, key)
}

// ---------------------------------------------------------------------------
// Shared readers
// ---------------------------------------------------------------------------

/// `soldRowsForBlueprint(blueprintId, days)`.
async fn sold_rows_for_blueprint(
    db: &MarketplaceDb,
    blueprint_id: i64,
    days: i64,
) -> Result<Vec<Json>> {
    query_rows(
        db,
        &format!(
            "select observed_day, condition, language, reverse, first_edition, graded, \
                    sold_qty, median_pkn, min_pkn, max_pkn \
               from cardtrader_sold_daily \
              where blueprint_id = $1::bigint \
                and observed_day >= current_date - ($2::int || ' days')::interval \
                and sold_qty > 0 \
              order by observed_day desc \
              limit {SOLD_ROWS_LIMIT}"
        ),
        &[SqlParam::Text(blueprint_id.to_string()), SqlParam::Int(days)],
    )
    .await
}

/// `soldSummaryForBlueprint(blueprintId, condition, language, days)`.
async fn sold_summary_for_blueprint(
    db: &MarketplaceDb,
    blueprint_id: i64,
    condition: Option<&str>,
    language: Option<&str>,
    days: i64,
) -> Result<Option<Json>> {
    let rows = sold_rows_for_blueprint(db, blueprint_id, days).await?;
    let (facet, _) = resolve_facet(&rows, &json!({}));
    let filtered: Vec<Json> = rows
        .into_iter()
        .filter(|row| crate::domain::poko_market_math::row_matches_slice(row, Some(facet), condition, language))
        .collect();
    Ok(sold_estimate_from_stats(
        sold_stats(&filtered).as_ref(),
        &facet_label(facet),
    ))
}

/// `liveAsksForBlueprint(blueprintId)`.
async fn live_asks_for_blueprint(db: &MarketplaceDb, blueprint_id: i64) -> Result<Vec<Json>> {
    let rows = query_rows(
        db,
        "with book as ( \
           select s.condition, s.language, s.properties, s.price, s.quantity, s.last_seen_at \
             from cardtrader_market_listing_snapshots s \
            where coalesce(s.blueprint_id, s.cardtrader_blueprint_id) = $1::bigint \
              and s.price::numeric > 0 and s.quantity > 0 \
         ), live as ( \
           select * from book \
            where last_seen_at >= (select max(last_seen_at) from book) - interval '20 hours' \
         ) \
         select cardtrader_sold_condition(condition) as condition, \
                nullif(cardtrader_sold_language(language), '') as language, \
                coalesce((properties->>'pokemon_reverse')::boolean, false) as reverse, \
                coalesce((properties->>'first_edition')::boolean, false) as first_edition, \
                false as graded, \
                count(*)::int as listings, sum(quantity)::int as copies, \
                min(price::numeric) as min_eur, \
                percentile_cont(0.5) within group (order by price::numeric) as median_eur \
           from live group by 1, 2, 3, 4",
        &[SqlParam::Text(blueprint_id.to_string())],
    )
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let language = field_str(&row, "language");
            let min_eur = row.get("min_eur").and_then(Json::as_f64).unwrap_or(0.0);
            let median_eur = row.get("median_eur").and_then(Json::as_f64).unwrap_or(0.0);
            json!({
                "condition": field_str(&row, "condition"),
                "language": if language.is_empty() { Json::Null } else { json!(language.to_ascii_uppercase()) },
                "reverse": row.get("reverse").and_then(Json::as_bool).unwrap_or(false),
                "first_edition": row.get("first_edition").and_then(Json::as_bool).unwrap_or(false),
                "graded": false,
                "listings": row.get("listings").and_then(Json::as_i64).unwrap_or(0),
                "copies": row.get("copies").and_then(Json::as_i64).unwrap_or(0),
                "minPkn": round2_or_none(min_eur / PKN_EUR_RATE).map(js_num),
                "medianPkn": round2_or_none(median_eur / PKN_EUR_RATE).map(js_num),
            })
        })
        .collect())
}

/// `askSignalForBlueprint(blueprintId)`.
async fn ask_signal_for_blueprint(db: &MarketplaceDb, blueprint_id: i64) -> Result<Option<Json>> {
    let rows = query_rows(
        db,
        "select min_price_pkn, (refreshed_at at time zone 'utc')::date as observed_day, refreshed_at \
           from cardtrader_blueprint_daily_analytics \
          where blueprint_id = $1::bigint \
          order by refreshed_at desc, observed_day desc limit 1",
        &[SqlParam::Text(blueprint_id.to_string())],
    )
    .await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    Ok(Some(json!({
        "min": round2_or_none(row.get("min_price_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
        "currency": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "observedDay": day_of(row.get("observed_day")),
        "source": "cardtrader_listed",
        "metric": "lowestAsk",
        "sourceTimestamp": row.get("refreshed_at").and_then(Json::as_str).map(str::to_string),
        "note": "lowest listed ask across all conditions/languages; asking price is not a confirmed sale",
    })))
}

/// `expansionForSetCode(code)`.
async fn expansion_for_set_code(db: &MarketplaceDb, code: &str) -> Result<String> {
    let compact: String = code
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if compact.len() < 2 || compact.len() > 8 {
        return Ok(String::new());
    }
    let rows = query_rows(
        db,
        "select expansion_name from marketplace_expansion_aliases \
          where compact_alias = $1 order by priority asc limit 1",
        &[SqlParam::Text(compact)],
    )
    .await?;
    Ok(rows.first().map(|row| field_str(row, "expansion_name")).unwrap_or_default())
}

/// `applySetAlias(rawQuery)` → `(query, setName)`.
async fn apply_set_alias(db: &MarketplaceDb, raw_query: &str) -> Result<(String, String)> {
    use crate::domain::poko_market_math::{digit_set_code, single_parenthetical_set, strip_asking_prices};
    let stripped = strip_asking_prices(raw_query);
    if let Some(paren) = single_parenthetical_set(&stripped) {
        let expansion = expansion_for_set_code(db, &paren.code).await?;
        if expansion.is_empty() {
            return Ok((stripped, String::new()));
        }
        let before = &stripped[..paren.index.min(stripped.len())];
        let query = format!("{before} {}", paren.number)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return Ok((query, expansion));
    }
    let code = digit_set_code(&stripped);
    if code.is_empty() {
        return Ok((stripped, String::new()));
    }
    let expansion = expansion_for_set_code(db, &code).await?;
    if expansion.is_empty() {
        return Ok((stripped, String::new()));
    }
    let pattern = Regex::new(&format!(r"(?i)\b{}\b", regex::escape(&code))).expect("set code regex");
    let query = pattern
        .replace_all(&stripped, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Ok((query, expansion))
}

/// `resolveCard(params)`.
async fn resolve_card(db: &MarketplaceDb, params: &Json) -> Result<Json> {
    use crate::domain::poko_market_math::{query_variants, stopwords};
    let query = param_string(params, "query", 120);
    let artist = param_string(params, "artist", 80);
    if query.is_empty() && artist.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "query or artist required" }));
    }
    let artist_pattern = if artist.is_empty() {
        None
    } else {
        Some(format!("%{}%", escape_like(&artist)))
    };
    let (aliased_query, aliased_set) = if query.is_empty() {
        (String::new(), String::new())
    } else {
        apply_set_alias(db, &query).await?
    };
    let base_query = if aliased_query.is_empty() {
        query.clone()
    } else {
        aliased_query.clone()
    };

    for variant in query_variants(&base_query) {
        let tokens: Vec<String> = variant
            .to_ascii_lowercase()
            .split_whitespace()
            .filter(|token| token.len() >= 2 && !stopwords().contains(*token))
            .map(str::to_string)
            .collect();
        if tokens.is_empty() {
            continue;
        }
        let mut conditions: Vec<String> = Vec::new();
        let mut values: Vec<SqlParam> = Vec::new();
        for (index, token) in tokens.iter().enumerate() {
            conditions.push(format!("s.search_text ilike ${}", index + 1));
            values.push(SqlParam::Text(format!("%{}%", escape_like(token))));
        }
        if let Some(pattern) = &artist_pattern {
            conditions.push(format!("s.artist ilike ${}", values.len() + 1));
            values.push(SqlParam::Text(pattern.clone()));
        }
        if !aliased_set.is_empty() {
            conditions.push(format!("s.set_name = ${}", values.len() + 1));
            values.push(SqlParam::Text(aliased_set.clone()));
        }
        let sql = format!(
            "select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, s.version, \
                    coalesce(nullif(c.card_number, ''), '') as card_number \
               from marketplace_search_candidates s \
               left join marketplace_cards c on c.card_id = s.card_id \
              where s.item_kind <> 'product' and {} \
              order by s.search_weight desc nulls last, s.name limit 24",
            conditions.join(" and ")
        );
        let rows = query_rows(db, &sql, &values).await?;
        if !rows.is_empty() {
            let deduped = dedupe_artwork_versions(&rows);
            let collapsed = rows.len().saturating_sub(deduped.len());
            let candidates: Vec<Json> = deduped
                .iter()
                .take(7)
                .map(candidate_from_row)
                .collect();
            let note = if candidates.len() > 1 {
                Some("Multiple different artworks match; ask which one they mean. Same-artwork reprints across products were collapsed.")
            } else if collapsed > 0 {
                Some("Other catalog rows are the same artwork in other products/half-decks; only one printing is returned.")
            } else {
                None
            };
            let mut body = Map::new();
            body.insert(
                "status".into(),
                json!(if candidates.len() == 1 { "ok" } else { "ambiguous" }),
            );
            body.insert("candidates".into(), Json::Array(candidates));
            if collapsed > 0 {
                body.insert("sameArtworkCollapsed".into(), json!(collapsed));
            }
            if let Some(note) = note {
                body.insert("note".into(), json!(note));
            }
            return Ok(Json::Object(body));
        }
    }
    Ok(json!({
        "status": "not_found",
        "error": "no catalog match",
        "note": "The assistant should ask the user to double-check the card name or set.",
    }))
}

/// The outcome of `requireCard`: an owned card, or the tool-level error payload.
enum Required {
    Card(Json),
    Failure(Json),
}

/// `requireCard(params)`.
async fn require_card(db: &MarketplaceDb, params: &Json) -> Result<Required> {
    let card_id = param_string(params, "cardId", 40);
    if !card_id.is_empty() && card_id.bytes().all(|byte| byte.is_ascii_digit()) {
        let rows = query_rows(
            db,
            "select card_id, ct_id, name, set_name, artist, item_kind \
               from marketplace_search_candidates where card_id = $1 limit 1",
            &[SqlParam::Text(card_id)],
        )
        .await?;
        let Some(row) = rows.first() else {
            return Ok(Required::Failure(
                json!({ "status": "not_found", "error": "unknown cardId" }),
            ));
        };
        return Ok(Required::Card(candidate_from_row(row)));
    }
    let resolved = resolve_card(
        db,
        &json!({ "query": param_string(params, "query", 120), "artist": param_string(params, "artist", 80) }),
    )
    .await?;
    let status = resolved.get("status").and_then(Json::as_str).unwrap_or("");
    if status != "ok" {
        let mut body = resolved.as_object().cloned().unwrap_or_default();
        body.insert("status".into(), json!(status));
        if status == "invalid" {
            body.insert("httpStatus".into(), json!(400));
        } else {
            body.insert("httpStatus".into(), json!(422));
        }
        return Ok(Required::Failure(Json::Object(body)));
    }
    let card = resolved
        .get("candidates")
        .and_then(Json::as_array)
        .and_then(|candidates| candidates.first())
        .cloned()
        .unwrap_or_else(|| json!({}));
    Ok(Required::Card(card))
}

// ---------------------------------------------------------------------------
// Price history (`_card_price_history.js` + `_tcgcsv_prices.js`)
// ---------------------------------------------------------------------------

fn cardtrader_source(rows: &[Json], status: &str) -> Json {
    let days: Vec<Json> = rows
        .iter()
        .map(|row| {
            let count = |key: &str| {
                row.get(key)
                    .and_then(Json::as_f64)
                    .unwrap_or(0.0)
                    .trunc()
                    .max(0.0) as i64
            };
            json!({
                "day": day_of(row.get("day")).unwrap_or_default(),
                "dumpDay": day_of(row.get("dump_day")).unwrap_or_default(),
                "lowestAskPkn": row.get("lowest_ask_pkn").and_then(Json::as_f64).unwrap_or(0.0),
                "listingCount": count("listing_count"),
                "listedQuantity": count("listed_quantity"),
                "sellerCount": count("seller_count"),
                "sourceTimestamp": row.get("refreshed_at").and_then(Json::as_str),
            })
        })
        .collect();
    let resolved = if status.is_empty() {
        if rows.is_empty() { "empty" } else { "available" }
    } else {
        status
    };
    json!({
        "source": "cardtrader_listed",
        "currency": "PKN",
        "metric": "lowestAsk",
        "status": resolved,
        "conditionSpecific": false,
        "languageSpecific": false,
        "days": days,
    })
}

fn tcgplayer_source(rows: &[Json], status: &str) -> Json {
    let mut order: Vec<String> = Vec::new();
    let mut by_product: HashMap<String, (Json, Vec<Json>)> = HashMap::new();
    for row in rows {
        let key = format!(
            "{}:{}:{}",
            row.get("category_id").map(|value| value.to_string()).unwrap_or_default(),
            row.get("product_id").map(|value| value.to_string()).unwrap_or_default(),
            row.get("subtype").map(|value| value.to_string()).unwrap_or_default(),
        );
        let entry = by_product.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            (
                json!({
                    "productId": row.get("product_id").map(|v| match v {
                        Json::String(text) => text.clone(),
                        other => other.to_string(),
                    }).unwrap_or_default(),
                    "categoryId": row.get("category_id").cloned().unwrap_or(Json::Null),
                    "groupId": row.get("group_id").cloned().unwrap_or(Json::Null),
                    "subtype": row.get("subtype").cloned().unwrap_or(Json::Null),
                    "days": [],
                }),
                Vec::new(),
            )
        });
        entry.1.push(json!({
            "day": day_of(row.get("observed_on")).unwrap_or_default(),
            "marketPrice": row.get("market_price").cloned().unwrap_or(Json::Null),
            "lowPrice": row.get("low_price").cloned().unwrap_or(Json::Null),
            "midPrice": row.get("mid_price").cloned().unwrap_or(Json::Null),
            "highPrice": row.get("high_price").cloned().unwrap_or(Json::Null),
            "directLowPrice": row.get("direct_low_price").cloned().unwrap_or(Json::Null),
            "sourceTimestamp": row.get("snapshot_timestamp").and_then(Json::as_str),
        }));
    }
    let series: Vec<Json> = order
        .iter()
        .map(|key| {
            let (mut base, days) = by_product.remove(key).expect("grouped key");
            base["days"] = Json::Array(days);
            base
        })
        .collect();
    let resolved = if status.is_empty() {
        if rows.is_empty() { "empty" } else { "available" }
    } else {
        status
    };
    json!({
        "source": "tcgcsv/tcgplayer",
        "currency": "USD",
        "metric": "marketPrice",
        "status": resolved,
        "conditionSpecific": false,
        "languageSpecific": false,
        "series": series,
    })
}

/// `readTcgplayerHistory(game, cardId, from, to)`.
async fn read_tcgplayer_history(
    tcg: Option<&MarketplaceDb>,
    game: &str,
    card_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<Json>> {
    let Some(tcg) = tcg else {
        // `readTcgplayerHistory` throws a 503 when TCGCSV_DATABASE_URL is unset.
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "TCGplayer history unavailable."));
    };
    let mapped = query_rows(
        tcg,
        "SELECT DISTINCT l.product_id, p.category_id \
           FROM pokoin_product_links l LEFT JOIN latest_prices p USING(product_id) \
          WHERE l.active AND l.game = $1 AND l.card_id = $2::bigint",
        &[SqlParam::Text(game.to_string()), SqlParam::Text(card_id.to_string())],
    )
    .await?;
    let mut products: Vec<String> = Vec::new();
    let mut categories: Vec<i32> = vec![3, 85];
    for row in &mapped {
        let product = row
            .get("product_id")
            .map(|value| match value {
                Json::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default();
        if !product.is_empty() && !products.contains(&product) {
            products.push(product);
        }
        if let Some(category) = row.get("category_id").and_then(Json::as_i64) {
            let category = category as i32;
            if !categories.contains(&category) {
                categories.push(category);
            }
        }
    }
    if products.is_empty() {
        return Ok(Vec::new());
    }
    query_rows(
        tcg,
        "SELECT p.* FROM all_daily_prices p \
          WHERE product_id = ANY($1::bigint[]) AND category_id = ANY($2::integer[]) \
            AND observed_on BETWEEN $3::date AND $4::date \
          ORDER BY observed_on, category_id, product_id, subtype",
        &[
            SqlParam::IntArray(products.iter().filter_map(|p| p.parse::<i64>().ok()).collect()),
            SqlParam::IntArray(categories.iter().map(|c| *c as i64).collect()),
            SqlParam::Text(from.to_string()),
            SqlParam::Text(to.to_string()),
        ],
    )
    .await
}

/// `readCardPriceHistory({game, cardId, from, to})`.
async fn read_card_price_history(
    db: &MarketplaceDb,
    tcg: Option<&MarketplaceDb>,
    game: &str,
    card_id: &str,
    from: &str,
    to: &str,
) -> Result<Json> {
    let rows = query_rows(
        db,
        "select card_id, ct_id, name, expansion_name, card_number \
           from public.marketplace_search_candidates where card_id = $1::bigint limit 1",
        &[SqlParam::Text(card_id.to_string())],
    )
    .await?;
    let Some(card) = rows.first() else {
        return Err(ApiError::not_found("Card not found."));
    };
    let ct_id = card.get("ct_id").and_then(Json::as_i64);

    // The CardTrader leg and the TCGplayer leg fail independently.
    let mut listed: Option<Vec<Json>> = None;
    let mut tcg_rows: Option<Vec<Json>> = None;
    let mut tcg_status = String::new();
    match ct_id {
        Some(ct_id) => {
            listed = query_rows(
                db,
                "select observed_day as dump_day, (refreshed_at at time zone 'utc')::date as day, \
                        min_price_pkn as lowest_ask_pkn, listing_count, listed_quantity, seller_count, refreshed_at \
                   from public.cardtrader_blueprint_daily_analytics \
                  where blueprint_id = $1::bigint \
                    and observed_day between $2::date - 1 and $3::date \
                    and (refreshed_at at time zone 'utc')::date between $2::date and $3::date \
                    and min_price_pkn > 0 and listing_count > 0 \
                  order by refreshed_at, observed_day",
                &[
                    SqlParam::Text(ct_id.to_string()),
                    SqlParam::Text(from.to_string()),
                    SqlParam::Text(to.to_string()),
                ],
            )
            .await
            .ok();
            match read_tcgplayer_history(tcg, game, card_id, from, to).await {
                Ok(rows) => tcg_rows = Some(rows),
                Err(error) => {
                    // `unconfigured` when there is no TCGCSV_DATABASE_URL at all.
                    tcg_status = if error.status() == StatusCode::SERVICE_UNAVAILABLE && tcg.is_none()
                    {
                        "unconfigured".to_string()
                    } else {
                        "unavailable".to_string()
                    };
                }
            }
        }
        None => {
            listed = Some(Vec::new());
        }
    }

    let card_id_text = field_str(card, "card_id");
    let cardtrader = match &listed {
        Some(rows) => cardtrader_source(rows, ""),
        None => cardtrader_source(&[], "unavailable"),
    };
    let tcgplayer = match &tcg_rows {
        Some(rows) => tcgplayer_source(rows, &tcg_status),
        None => tcgplayer_source(&[], &tcg_status),
    };
    Ok(json!({
        "game": game,
        "cardId": if card_id_text.is_empty() { card_id.to_string() } else { card_id_text },
        "ctId": ct_id.map(|id| id.to_string()),
        "from": from,
        "to": to,
        "printing": {
            "name": field_str(card, "name"),
            "setName": field_str(card, "expansion_name"),
            "number": field_str(card, "card_number"),
        },
        "cardtrader": cardtrader,
        "tcgplayer": tcgplayer,
    }))
}

/// `recentPriceSources(card, days)`.
async fn recent_price_sources(deps: &MarketDeps, card: &Json, days: f64) -> Result<Json> {
    let bounded_days = (days.trunc().max(1.0).min(90.0)) as i64;
    let from = deps.days_ago(bounded_days - 1);
    let to = deps.today();
    let card_id = field_str(card, "cardId");
    let history = match read_card_price_history(
        &deps.db,
        deps.tcg.as_ref(),
        &deps.game,
        &card_id,
        &from,
        &to,
    )
    .await
    {
        Ok(history) => history,
        Err(_) => json!({
            "cardtrader": cardtrader_source(&[], "unavailable"),
            "tcgplayer": tcgplayer_source(&[], "unavailable"),
        }),
    };
    let mut query = format!("cardId={card_id}&from={from}&to={to}");
    if deps.game != "pokemon" {
        query = format!("{query}&game={}", deps.game);
    }
    Ok(json!({
        "from": from,
        "to": to,
        "cardtrader": history.get("cardtrader").cloned().unwrap_or(Json::Null),
        "tcgplayer": history.get("tcgplayer").cloned().unwrap_or(Json::Null),
        "citationUrl": format!("https://api.pokoin.com/api/marketplace-card-price-history?{query}"),
    }))
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async fn card_liquidity(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let required = require_card(&deps.db, params).await?;
    let card = match required {
        Required::Card(card) => card,
        Required::Failure(body) => return Ok(body),
    };
    let card_id = field_str(&card, "cardId");
    let rows = query_rows(
        &deps.db,
        "select sold_qty_7d, listed_now, sell_through, days_of_supply, demand_score, updated_at \
           from marketplace_card_weights where card_id = $1 limit 1",
        &[SqlParam::Text(card_id)],
    )
    .await?;
    let weights = rows.first().cloned();
    let mut bands = None;
    let mut source = "weights";
    if let Some(weights) = &weights {
        let updated_at = field_str(weights, "updated_at");
        if crate::domain::poko_market_math::weights_are_fresh(&updated_at, deps.now_ms) {
            bands = liquidity_bands(
                weights.get("days_of_supply"),
                weights.get("sold_qty_7d"),
                weights.get("listed_now"),
            );
        }
    }
    if bands.is_none() {
        if let Some(blueprint_id) = card.get("blueprintId").and_then(Json::as_i64) {
            let sold = sold_summary_for_blueprint(&deps.db, blueprint_id, None, None, 28).await?;
            let sample = sold
                .as_ref()
                .and_then(|sold| sold.get("sampleSize"))
                .and_then(Json::as_f64)
                .unwrap_or(0.0);
            if sample > 0.0 {
                bands = liquidity_bands(None, Some(&json!(sample / 4.0)), Some(&json!(1)));
                source = "sold_daily_fallback";
            }
        }
    }
    let liquidity = match bands {
        Some(bands) => {
            let mut object = bands.as_object().cloned().unwrap_or_default();
            object.insert("source".into(), json!(source));
            Json::Object(object)
        }
        None => json!({
            "typicalDays": Json::Null,
            "methodology": "insufficient market activity",
            "confidence": "none",
            "source": "none",
        }),
    };
    Ok(json!({
        "status": "ok",
        "card": card,
        "liquidity": liquidity,
        "weights": match &weights {
            Some(weights) => json!({
                "soldQty7d": weights.get("sold_qty_7d").and_then(Json::as_f64).unwrap_or(0.0),
                "listedNow": weights.get("listed_now").and_then(Json::as_f64).unwrap_or(0.0),
                "sellThrough": round2_or_none(weights.get("sell_through").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
                "daysOfSupply": round2_or_none(weights.get("days_of_supply").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
            }),
            None => Json::Null,
        },
    }))
}

async fn card_quote(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let required = require_card(&deps.db, params).await?;
    let card = match required {
        Required::Card(card) => card,
        Required::Failure(body) => return Ok(body),
    };
    let Some(blueprint_id) = card.get("blueprintId").and_then(Json::as_i64) else {
        return Ok(json!({
            "status": "unsupported",
            "error": "card_quote needs an explicit catalog blueprint mapping",
            "card": card,
        }));
    };

    let cond = normalize_condition(&param_string(params, "condition", 200));
    let lang = normalize_language(&param_string(params, "language", 200));
    let condition_given = cond.matched;
    let language_given = lang.matched;

    // Unstated condition/language mean "every copy of this variant", not NM/EN.
    struct Variant {
        condition: Option<&'static str>,
        language: Option<&'static str>,
        vague: bool,
    }
    let mut variants: Vec<Variant> = vec![Variant {
        condition: if condition_given { Some(cond.primary) } else { None },
        language: if language_given { Some(lang.code) } else { None },
        vague: false,
    }];
    if cond.vague && !cond.alternatives.is_empty() {
        variants[0].vague = true;
        variants.push(Variant {
            condition: cond.alternatives.first().copied(),
            language: variants[0].language,
            vague: true,
        });
    }

    let rows = sold_rows_for_blueprint(&deps.db, blueprint_id, 90).await?;
    let live_groups = live_asks_for_blueprint(&deps.db, blueprint_id).await?;
    let price_days = param_number(params, "priceDays").unwrap_or(14.0);
    let price_sources = recent_price_sources(deps, &card, price_days).await?;
    let liquidity = card_liquidity(deps, &json!({ "cardId": field_str(&card, "cardId") })).await?;
    let blueprint_ask = ask_signal_for_blueprint(&deps.db, blueprint_id).await?;

    let (facet, snapped) = resolve_facet(&rows, params);
    let facet_rows: Vec<Json> = rows
        .iter()
        .filter(|row| crate::domain::poko_market_math::row_matches_facet(row, facet))
        .cloned()
        .collect();
    let variant_label = facet_label(facet);

    let mut quotes: Vec<Json> = Vec::new();
    for variant in &variants {
        let mut stats = sold_stats(
            &rows
                .iter()
                .filter(|row| {
                    crate::domain::poko_market_math::row_matches_slice(
                        row,
                        Some(facet),
                        variant.condition,
                        variant.language,
                    )
                })
                .cloned()
                .collect::<Vec<_>>(),
        );
        let mut fallback: Option<String> = None;
        if stats.is_none()
            && (variant.condition.is_some() || variant.language.is_some())
            && !facet_rows.is_empty()
        {
            stats = sold_stats(&facet_rows);
            let parts: Vec<&str> = [variant.condition, variant.language]
                .into_iter()
                .flatten()
                .collect();
            fallback = Some(format!(
                "No {} sale of this variant in 90 days; estimate uses every condition and language of the same variant.",
                parts.join(" ")
            ));
        }
        let basis = [
            Some(variant_label.clone()),
            Some(if fallback.is_some() {
                "all conditions, all languages".to_string()
            } else {
                variant.condition.unwrap_or("all conditions").to_string()
            }),
            if fallback.is_some() {
                None
            } else {
                Some(variant.language.unwrap_or("all languages").to_string())
            },
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
        let estimate = sold_estimate_from_stats(stats.as_ref(), &basis);
        let live_match: Vec<Json> = live_groups
            .iter()
            .filter(|group| {
                crate::domain::poko_market_math::row_matches_slice(
                    group,
                    Some(facet),
                    variant.condition,
                    variant.language,
                )
            })
            .cloned()
            .collect();
        let current_ask = summarize_live_asks(&live_match).or_else(|| {
            blueprint_ask.as_ref().map(|ask| {
                let mut object = ask.as_object().cloned().unwrap_or_default();
                object.insert(
                    "basis".into(),
                    json!("lowest ask across all conditions/languages/variants (no same-slice live listing)"),
                );
                Json::Object(object)
            })
        });
        let exact_slice = variant.condition.is_some() && variant.language.is_some() && fallback.is_none();
        let ask_vs_sold = if exact_slice {
            match (
                current_ask.as_ref().and_then(|ask| ask.get("min")).and_then(Json::as_f64),
                estimate.as_ref().and_then(|value| value.get("median")).and_then(Json::as_f64),
            ) {
                (Some(ask), Some(median)) => deal_verdict(ask, median),
                _ => None,
            }
        } else {
            None
        };
        let liquidity_bands_value = liquidity.get("liquidity").cloned();
        let strategies = price_strategies(
            estimate.as_ref(),
            if exact_slice { current_ask.as_ref() } else { None },
            liquidity_bands_value.as_ref(),
        );
        let mut quote = Map::new();
        quote.insert(
            "condition".into(),
            json!(variant.condition.unwrap_or("all")),
        );
        quote.insert("language".into(), json!(variant.language.unwrap_or("all")));
        if variant.vague {
            quote.insert("vagueWording".into(), json!(true));
        }
        quote.insert("estimate".into(), estimate.clone().unwrap_or(Json::Null));
        if let Some(fallback) = &fallback {
            quote.insert("estimateFallback".into(), json!(fallback));
        }
        quote.insert("currentAsk".into(), current_ask.clone().unwrap_or(Json::Null));
        quote.insert("askVsSold".into(), ask_vs_sold.clone().unwrap_or(Json::Null));
        if let Some(inner) = liquidity_bands_value {
            quote.insert("liquidity".into(), inner);
        }
        quote.insert("strategies".into(), strategies.unwrap_or(Json::Null));
        quote.insert("askingPriceOnly".into(), json!(estimate.is_none()));
        quotes.push(Json::Object(quote));
    }

    let window_from = deps.days_ago(90);
    let window_to = deps.days_ago(0);
    let mut body = Map::new();
    body.insert("status".into(), json!("ok"));
    body.insert("today".into(), json!(deps.today()));
    body.insert("priceUnit".into(), json!("PKN"));
    body.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    body.insert("card".into(), card);
    body.insert(
        "filters".into(),
        json!({
            "condition": if condition_given { cond.primary } else { "all" },
            "language": if language_given { lang.code } else { "all" },
            "conditionVague": cond.vague,
            "variant": variant_label,
        }),
    );
    if snapped {
        body.insert(
            "variantNote".into(),
            json!(format!(
                "This printing never sold a standard copy in 90 days; quoting its most-sold variant ({variant_label})."
            )),
        );
    }
    body.insert(
        "window".into(),
        json!({ "soldDays": 90, "from": window_from, "to": window_to }),
    );
    body.insert("priceSources".into(), price_sources.clone());
    body.insert(
        "askHistory".into(),
        ask_history_from_source(
            price_sources.get("cardtrader"),
            (price_days.trunc().max(1.0).min(90.0)) as i64,
        ),
    );
    if cond.vague {
        body.insert(
            "conditionNote".into(),
            json!(format!(
                "Vague condition wording: showing {} and {} ranges instead of claiming a grade.",
                cond.primary,
                cond.alternatives.first().copied().unwrap_or("")
            )),
        );
    }
    body.insert("quotes".into(), Json::Array(quotes));
    body.insert("variantsSold".into(), Json::Array(variants_sold(&rows)));
    body.insert(
        "soldByConditionLanguage".into(),
        Json::Array(sold_by_condition_language(&facet_rows, 8)),
    );
    body.insert("dataNote".into(), json!("Recorded sold comps are sanitized CardTrader inferred sales; variants/conditions/languages stay separate. priceSources.cardtrader is daily lowest listed ask PKN, not a sold price or measured median. priceSources.tcgplayer is daily aggregate TCGplayer market quotes in USD, condition/language unspecified; never convert USD into PKN implicitly. Report source, subtype and observation date, cite citationUrl. Zero sold comps does not mean no price analytics; use available dated quotes and disclose they are asking/aggregate prices."));
    Ok(Json::Object(body))
}

async fn card_sales(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let required = require_card(&deps.db, params).await?;
    let card = match required {
        Required::Card(card) => card,
        Required::Failure(body) => return Ok(body),
    };
    let Some(blueprint_id) = card.get("blueprintId").and_then(Json::as_i64) else {
        return Ok(json!({
            "status": "unsupported",
            "error": "card_sales needs an explicit catalog blueprint mapping",
            "card": card,
        }));
    };
    let days = bounded(params, "days", 30.0, 1.0, 90.0) as i64;
    let limit = bounded(params, "limit", 25.0, 1.0, 60.0) as usize;
    let cond = normalize_condition(&param_string(params, "condition", 200));
    let lang = normalize_language(&param_string(params, "language", 200));
    let condition = if cond.matched && !cond.vague { Some(cond.primary) } else { None };
    let language = if lang.matched { Some(lang.code) } else { None };

    let rows = sold_rows_for_blueprint(&deps.db, blueprint_id, 90).await?;
    let (facet, snapped) = resolve_facet(&rows, params);
    let slice_rows: Vec<Json> = rows
        .iter()
        .filter(|row| {
            crate::domain::poko_market_math::row_matches_slice(row, Some(facet), condition, language)
        })
        .cloned()
        .collect();
    let window_start = deps.days_ago(days);
    let in_window: Vec<Json> = slice_rows
        .iter()
        .filter(|row| {
            day_of(row.get("observed_day"))
                .map(|day| day >= window_start)
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    let since = |n: i64| -> Json {
        let from = deps.days_ago(n);
        let stats = sold_stats(
            &slice_rows
                .iter()
                .filter(|row| {
                    day_of(row.get("observed_day"))
                        .map(|day| day >= from)
                        .unwrap_or(false)
                })
                .cloned()
                .collect::<Vec<_>>(),
        );
        match stats {
            Some(stats) => json!({
                "units": stats.sold_qty,
                "saleDays": stats.sale_days,
                "medianPkn": stats.median.map(js_num),
                "lowPkn": stats.min.map(js_num),
                "highPkn": stats.max.map(js_num),
            }),
            None => json!({ "units": 0, "saleDays": 0, "medianPkn": Json::Null }),
        }
    };

    let mut sorted = in_window.clone();
    sorted.sort_by(|a, b| {
        let left = day_of(a.get("observed_day")).unwrap_or_default();
        let right = day_of(b.get("observed_day")).unwrap_or_default();
        right.cmp(&left)
    });
    let sales: Vec<Json> = sorted
        .iter()
        .take(limit)
        .map(|row| {
            json!({
                "day": day_of(row.get("observed_day")),
                "condition": field_str(row, "condition"),
                "language": field_str(row, "language").to_ascii_uppercase(),
                "units": row.get("sold_qty").and_then(Json::as_f64).unwrap_or(0.0),
                "medianPkn": round2_or_none(row.get("median_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
                "lowPkn": round2_or_none(row.get("min_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
                "highPkn": round2_or_none(row.get("max_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
            })
        })
        .collect();
    let label = facet_label(facet);
    let mut body = Map::new();
    body.insert("status".into(), json!("ok"));
    body.insert("today".into(), json!(deps.today()));
    body.insert("priceUnit".into(), json!("PKN"));
    body.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    body.insert("card".into(), card);
    body.insert(
        "filters".into(),
        json!({
            "variant": label,
            "condition": condition.unwrap_or("all"),
            "language": language.unwrap_or("all"),
        }),
    );
    if snapped {
        body.insert(
            "variantNote".into(),
            json!(format!("No standard-copy sales; showing the most-sold variant ({label}).")),
        );
    }
    body.insert(
        "window".into(),
        json!({ "days": days, "from": window_start, "to": deps.days_ago(0) }),
    );
    body.insert(
        "totals".into(),
        json!({ "last7d": since(7), "last30d": since(30), "last90d": since(90) }),
    );
    body.insert("lastSale".into(), sales.first().cloned().unwrap_or(Json::Null));
    body.insert("sales".into(), Json::Array(sales.clone()));
    body.insert(
        "otherVariants".into(),
        Json::Array(
            variants_sold(&rows)
                .into_iter()
                .filter(|variant| variant.get("variant").and_then(Json::as_str) != Some(label.as_str()))
                .collect(),
        ),
    );
    body.insert(
        "note".into(),
        json!(if sales.is_empty() {
            format!("No sale of this variant in the last {days} days.")
        } else {
            "Each row is one day × condition × language: units that left the CardTrader book and their median price that day.".to_string()
        }),
    );
    Ok(Json::Object(body))
}

async fn deal_check(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let required = require_card(&deps.db, params).await?;
    let card = match required {
        Required::Card(card) => card,
        Required::Failure(body) => return Ok(body),
    };
    let Some(blueprint_id) = card.get("blueprintId").and_then(Json::as_i64) else {
        return Ok(json!({
            "status": "unsupported",
            "error": "deal_check needs an explicit catalog blueprint mapping",
            "card": card,
        }));
    };
    let cond = normalize_condition(&param_string(params, "condition", 200));
    let lang = normalize_language(&param_string(params, "language", 200));
    let condition = if cond.matched && !cond.vague { Some(cond.primary) } else { None };
    let language = if lang.matched { Some(lang.code) } else { None };

    let rows = sold_rows_for_blueprint(&deps.db, blueprint_id, 90).await?;
    let live_groups = live_asks_for_blueprint(&deps.db, blueprint_id).await?;
    let facet = sold_facet_from_params(params);
    let mut offers: Vec<Json> = live_groups
        .iter()
        .filter(|group| {
            crate::domain::poko_market_math::row_matches_slice(
                group,
                if facet.explicit { Some(facet) } else { None },
                condition,
                language,
            )
        })
        .map(|group| {
            let group_facet = Facet {
                reverse: group.get("reverse").and_then(Json::as_bool).unwrap_or(false),
                first_edition: group.get("first_edition").and_then(Json::as_bool).unwrap_or(false),
                graded: false,
                explicit: false,
            };
            let group_condition = field_str(group, "condition");
            let group_language = match group.get("language") {
                Some(Json::String(text)) if !text.is_empty() => Some(text.clone()),
                _ => None,
            };
            let comps = sold_stats(
                &rows
                    .iter()
                    .filter(|row| {
                        crate::domain::poko_market_math::row_matches_slice(
                            row,
                            Some(group_facet),
                            Some(&group_condition),
                            group_language.as_deref(),
                        )
                    })
                    .cloned()
                    .collect::<Vec<_>>(),
            );
            let has_comps = comps
                .as_ref()
                .map(|comps| comps.sold_qty >= crate::domain::poko_market_math::DEAL_MIN_COMPS)
                .unwrap_or(false);
            let min_pkn = group.get("minPkn").and_then(Json::as_f64).unwrap_or(0.0);
            let verdict = match (has_comps, comps.as_ref().and_then(|comps| comps.median)) {
                (true, Some(median)) => deal_verdict(min_pkn, median),
                _ => Some(json!({ "verdict": "no_same_slice_sales", "ratio": Json::Null })),
            };
            let mut offer = Map::new();
            offer.insert("variant".into(), json!(facet_label(group_facet)));
            offer.insert("condition".into(), json!(group_condition));
            offer.insert(
                "language".into(),
                json!(group_language.clone().unwrap_or_else(|| "print language".to_string())),
            );
            offer.insert("cheapestAskPkn".into(), group.get("minPkn").cloned().unwrap_or(Json::Null));
            offer.insert(
                "cheapestAskEur".into(),
                round2_or_none(min_pkn * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
            );
            offer.insert("listings".into(), group.get("listings").cloned().unwrap_or(json!(0)));
            offer.insert(
                "soldMedianPkn".into(),
                if has_comps {
                    comps.as_ref().and_then(|comps| comps.median).map(js_num).unwrap_or(Json::Null)
                } else {
                    Json::Null
                },
            );
            offer.insert(
                "soldUnits90d".into(),
                json!(comps.as_ref().map(|comps| comps.sold_qty).unwrap_or(0)),
            );
            offer.insert(
                "lastSaleDay".into(),
                comps
                    .as_ref()
                    .and_then(|comps| comps.last_sale_day.clone())
                    .map(|day| json!(day))
                    .unwrap_or(Json::Null),
            );
            if let Some(verdict) = verdict.and_then(|verdict| verdict.as_object().cloned()) {
                for (key, value) in verdict {
                    offer.insert(key, value);
                }
            }
            Json::Object(offer)
        })
        .collect();
    offers.sort_by(|a, b| {
        let left = a.get("cheapestAskPkn").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("cheapestAskPkn").and_then(Json::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });

    // far_below comps are usually pulled high asks, so never headline them.
    let mut compared: Vec<&Json> = offers
        .iter()
        .filter(|offer| {
            !offer.get("ratio").map(Json::is_null).unwrap_or(true)
                && offer.get("verdict").and_then(Json::as_str) != Some("far_below_sold_median")
        })
        .collect();
    compared.sort_by(|a, b| {
        let left = a.get("ratio").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("ratio").and_then(Json::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });
    let best_value = compared.first().map(|offer| (*offer).clone()).unwrap_or(Json::Null);
    let offer_count = offers.len();
    let mut body = Map::new();
    body.insert("status".into(), json!("ok"));
    body.insert("today".into(), json!(deps.today()));
    body.insert("priceUnit".into(), json!("PKN"));
    body.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    body.insert("card".into(), card);
    body.insert(
        "filters".into(),
        json!({
            "variant": if facet.explicit { facet_label(facet) } else { "all live variants".to_string() },
            "condition": condition.unwrap_or("all"),
            "language": language.unwrap_or("all"),
        }),
    );
    body.insert("bestValue".into(), best_value);
    body.insert("offers".into(), Json::Array(offers.iter().take(10).cloned().collect()));
    body.insert("liveListingGroups".into(), json!(offer_count));
    body.insert(
        "note".into(),
        json!(if offer_count == 0 {
            "No live CardTrader listing for this printing with these filters."
        } else {
            "ratio = cheapest ask ÷ 90-day sold median of the exact same variant/condition/language. below_sold_median ≤ 0.8, in_line ≤ 1.2. Market data, not financial advice."
        }),
    );
    Ok(Json::Object(body))
}

async fn card_ocr(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let required = require_card(&deps.db, params).await?;
    let card = match required {
        Required::Card(card) => card,
        Required::Failure(body) => return Ok(body),
    };
    let leftover_id = card.get("blueprintId").cloned().unwrap_or(Json::Null);
    let rows = query_rows(
        &deps.db,
        "select card_id, leftover_id, name, set_name, card_number, text, junk, ok, \
                engine, crop, line_count, updated_at \
           from marketplace_card_ocr \
          where card_id = $1 or ($2::bigint is not null and leftover_id = $2) \
          order by (card_id = $1) desc limit 1",
        &[
            SqlParam::Text(field_str(&card, "cardId")),
            match leftover_id.as_i64() {
                Some(id) => SqlParam::Int(id),
                None => SqlParam::Null,
            },
        ],
    )
    .await?;
    let row = rows.first();
    let not_found = || {
        json!({
            "status": "not_found",
            "card": card.clone(),
            "error": "no OCR text for this printing yet (western leftovers only)",
            "note": "Say you do not have scanned card text for this printing; do not invent attacks or HP.",
        })
    };
    let Some(row) = row else {
        return Ok(not_found());
    };
    if !row.get("ok").and_then(Json::as_bool).unwrap_or(false) {
        return Ok(not_found());
    }
    let text: String = field_str(row, "text")
        .trim()
        .chars()
        .take(1500)
        .collect();
    if text.is_empty() {
        return Ok(json!({
            "status": "not_found",
            "card": card,
            "error": "OCR row empty",
            "note": "Say you do not have scanned card text for this printing; do not invent attacks or HP.",
        }));
    }
    let junk = row.get("junk").and_then(Json::as_bool).unwrap_or(false);
    let leftover = row
        .get("leftover_id")
        .and_then(Json::as_i64)
        .or(leftover_id.as_i64());
    Ok(json!({
        "status": "ok",
        "card": card,
        "ocr": {
            "text": text,
            "junk": junk,
            "crop": row.get("crop").and_then(Json::as_str),
            "engine": row.get("engine").and_then(Json::as_str),
            "lineCount": row.get("line_count").and_then(Json::as_i64),
            "leftoverId": leftover,
            "updatedAt": row.get("updated_at").map(|value| match value {
                Json::String(text) => text.clone(),
                other => other.to_string(),
            }),
            "methodology": "western leftover PP-OCRv5 chrome; approximate, not official card text",
            "confidence": if junk { "low" } else { "medium" },
        },
        "note": if junk {
            "OCR looks noisy (energy/short chrome). Prefer catalog identity over this text."
        } else {
            "Use this OCR only for attacks/abilities/rules on this cardId; never swap to another printing."
        },
    }))
}

async fn collection_quote(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let artist_input = param_string(params, "artist", 80);
    if artist_input.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "artist required" }));
    }
    let cond = normalize_condition(&param_string(params, "condition", 200).if_empty("NM"));
    let lang = normalize_language(&param_string(params, "language", 200).if_empty("EN"));

    let artist_rows = query_rows(
        &deps.db,
        "select artist, count(*)::int as cards \
           from marketplace_search_candidates \
          where item_kind <> 'product' and artist <> '' and (artist = $1 or artist ilike $2) \
          group by artist order by (artist = $1) desc, cards desc limit 5",
        &[
            SqlParam::Text(artist_input.clone()),
            SqlParam::Text(fuzzy_artist_pattern(&artist_input)),
        ],
    )
    .await?;
    if artist_rows.is_empty() {
        return Ok(json!({ "status": "not_found", "error": "no artist matches that name" }));
    }
    let has_exact = artist_rows.iter().any(|row| {
        field_str(row, "artist").to_ascii_lowercase() == artist_input.to_ascii_lowercase()
    });
    if artist_rows.len() > 1 && !has_exact {
        return Ok(json!({
            "status": "ambiguous",
            "artists": artist_rows.iter().map(|row| json!({
                "artist": field_str(row, "artist"),
                "cards": row.get("cards").and_then(Json::as_i64).unwrap_or(0),
            })).collect::<Vec<_>>(),
            "note": "Ask one concise clarification question; do not silently resolve.",
        }));
    }
    let artist = field_str(&artist_rows[0], "artist");

    let card_rows = query_rows(
        &deps.db,
        "select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, \
                coalesce(nullif(c.card_number, ''), '') as card_number \
           from marketplace_search_candidates s \
           left join marketplace_cards c on c.card_id = s.card_id \
          where s.item_kind <> 'product' and s.artist = $1 \
          order by s.name limit $2",
        &[SqlParam::Text(artist.clone()), SqlParam::Int(MAX_COLLECTION_CARDS as i64)],
    )
    .await?;
    let cards: Vec<Json> = card_rows.iter().map(candidate_from_row).collect();
    if cards.is_empty() {
        return Ok(json!({ "status": "not_found", "error": "no catalog cards for that artist" }));
    }
    let blueprint_ids: Vec<i64> = cards
        .iter()
        .filter_map(|card| card.get("blueprintId").and_then(Json::as_i64))
        .collect();

    let sold_rows = if blueprint_ids.is_empty() {
        Vec::new()
    } else {
        query_rows(
            &deps.db,
            "select blueprint_id, sum(sold_qty)::int as sold_qty, \
                    percentile_cont(0.5) within group (order by median_pkn) as median_daily \
               from cardtrader_sold_daily \
              where blueprint_id = any($1::bigint[]) \
                and observed_day >= current_date - interval '90 days' \
                and ($2::text is null or condition = $2) \
                and ($3::text is null or language = $3) \
                and sold_qty > 0 \
              group by blueprint_id",
            &[
                SqlParam::IntArray(blueprint_ids.clone()),
                SqlParam::Text(cond.primary.to_string()),
                SqlParam::Text(lang.code.to_string()),
            ],
        )
        .await?
    };
    let ask_rows = if blueprint_ids.is_empty() {
        Vec::new()
    } else {
        query_rows(
            &deps.db,
            "select distinct on (blueprint_id) blueprint_id, min_price_pkn, observed_day \
               from cardtrader_blueprint_daily_analytics \
              where blueprint_id = any($1::bigint[]) \
              order by blueprint_id, observed_day desc",
            &[SqlParam::IntArray(blueprint_ids.clone())],
        )
        .await?
    };
    let sold_by: HashMap<String, Json> = sold_rows
        .into_iter()
        .map(|row| (row_text(&row, "blueprint_id"), row))
        .collect();
    let ask_by: HashMap<String, Json> = ask_rows
        .into_iter()
        .map(|row| (row_text(&row, "blueprint_id"), row))
        .collect();

    let mut priced = 0i64;
    let mut market_total = 0.0f64;
    let mut acquire_total = 0.0f64;
    let mut priced_cards: Vec<Json> = Vec::new();
    for card in &cards {
        let blueprint = card.get("blueprintId").and_then(Json::as_i64);
        let key = blueprint.map(|id| id.to_string());
        let sold = key.as_ref().and_then(|key| sold_by.get(key));
        let ask = key.as_ref().and_then(|key| ask_by.get(key));
        let sold_qty = sold
            .and_then(|row| row.get("sold_qty"))
            .and_then(Json::as_f64)
            .unwrap_or(0.0);
        let sold_median = if sold_qty > 0.0 {
            sold.and_then(|row| row.get("median_daily"))
                .and_then(Json::as_f64)
                .and_then(round2_or_none)
        } else {
            None
        };
        let min_ask = ask
            .and_then(|row| row.get("min_price_pkn"))
            .and_then(Json::as_f64)
            .and_then(round2_or_none);
        if sold_median.is_none() && min_ask.is_none() {
            continue;
        }
        priced += 1;
        let market_value = sold_median.or(min_ask).unwrap_or(0.0);
        let acquisition = min_ask.or(sold_median).unwrap_or(0.0);
        market_total += market_value;
        acquire_total += acquisition;
        priced_cards.push(json!({
            "cardId": field_str(card, "cardId"),
            "name": field_str(card, "name"),
            "setName": field_str(card, "setName"),
            "cardNumber": field_str(card, "cardNumber"),
            "value": js_num(market_value),
            "basis": if sold_median.is_some() { "sold_median_90d" } else { "lowest_current_ask" },
            "soldQty90d": sold_qty,
        }));
    }
    priced_cards.sort_by(|a, b| {
        let left = a.get("value").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("value").and_then(Json::as_f64).unwrap_or(0.0);
        right.partial_cmp(&left).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut lowest = priced_cards.clone();
    lowest.sort_by(|a, b| {
        let left = a.get("soldQty90d").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("soldQty90d").and_then(Json::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });
    let total_cards = cards.len();
    let mut body = Map::new();
    body.insert("status".into(), json!("ok"));
    body.insert("artist".into(), json!(artist));
    body.insert("priceUnit".into(), json!("PKN"));
    body.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    body.insert(
        "filters".into(),
        json!({ "condition": cond.primary, "language": lang.code, "quantityPerCard": 1 }),
    );
    body.insert("cardsTotal".into(), json!(total_cards));
    body.insert("cardsPriced".into(), json!(priced));
    body.insert("cardsUnpriced".into(), json!(total_cards as i64 - priced));
    body.insert(
        "coveragePct".into(),
        json!(if total_cards == 0 {
            0
        } else {
            ((priced as f64 / total_cards as f64) * 100.0).round() as i64
        }),
    );
    body.insert("estimatedMarketValue".into(), js_num(round2(market_total)));
    body.insert("estimatedAcquisitionCost".into(), js_num(round2(acquire_total)));
    body.insert("note".into(), json!("estimated market value (sold medians) and cost to acquire today (lowest asks) are different metrics; when few copies exist, acquisition cost is the realistic one."));
    body.insert("mostExpensive".into(), Json::Array(priced_cards.iter().take(5).cloned().collect()));
    body.insert("lowestLiquidity".into(), Json::Array(lowest.iter().take(5).cloned().collect()));
    if total_cards >= MAX_COLLECTION_CARDS {
        body.insert("truncated".into(), json!(true));
    }
    Ok(Json::Object(body))
}

async fn suggest_cards(deps: &MarketDeps, params: &Json) -> Result<Json> {
    use crate::domain::poko_market_math::stopwords;
    let subject = param_string(params, "subject", 80);
    let exclude_card_id = param_string(params, "excludeCardId", 40);
    let limit = bounded(params, "limit", 6.0, 1.0, 12.0) as usize;
    if subject.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "subject required" }));
    }
    let tokens: Vec<String> = subject
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !stopwords().contains(*token))
        .map(str::to_string)
        .collect();
    if tokens.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "subject required" }));
    }
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlParam> = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        conditions.push(format!("s.search_text ilike ${}", index + 1));
        values.push(SqlParam::Text(format!("%{}%", escape_like(token))));
    }
    let exclude_param = values.len() + 1;
    values.push(if exclude_card_id.is_empty() {
        SqlParam::Null
    } else {
        SqlParam::Text(exclude_card_id.clone())
    });
    let sql = format!(
        "select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, s.version, \
                coalesce(nullif(c.card_number, ''), '') as card_number, ask.min_price_pkn \
           from marketplace_search_candidates s \
           left join marketplace_cards c on c.card_id = s.card_id \
           left join cardtrader_blueprint_daily_analytics ask on ask.blueprint_id = s.ct_id \
             and ask.observed_day = (select max(observed_day) from cardtrader_blueprint_daily_analytics) \
          where s.item_kind <> 'product' and {} \
            and (${exclude_param}::text is null or s.card_id::text <> ${exclude_param}::text) \
          order by s.search_weight desc nulls last, s.name limit {}",
        conditions.join(" and "),
        (limit * 4).max(24),
    );
    let rows = query_rows(&deps.db, &sql, &values).await?;
    let filtered: Vec<Json> = rows
        .into_iter()
        .filter(|row| row_text(row, "card_id") != exclude_card_id)
        .collect();
    let candidates: Vec<Json> = dedupe_artwork_versions(&filtered)
        .iter()
        .take(limit)
        .map(|row| {
            let mut card = candidate_from_row(row)
                .as_object()
                .cloned()
                .unwrap_or_default();
            let min_ask = row
                .get("min_price_pkn")
                .and_then(Json::as_f64)
                .and_then(round2_or_none)
                .map(js_num);
            card.insert("minAsk".into(), min_ask.clone().unwrap_or(Json::Null));
            card.insert("pricePkn".into(), min_ask.unwrap_or(Json::Null));
            Json::Object(card)
        })
        .collect();
    if candidates.is_empty() {
        return Ok(json!({
            "status": "not_found",
            "error": "no catalog cards match that subject",
        }));
    }
    Ok(json!({
        "status": "ok",
        "subject": subject,
        "priceUnit": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "cards": candidates,
        "note": "Real Pokoin catalog cards with current lowest ask in PKN. Same-artwork reprints are collapsed; different artworks of the same name may appear. Convert to other currencies only when the user asks.",
    }))
}

async fn market_snapshot(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let limit = bounded(params, "limit", 10.0, 1.0, 50.0) as i64;
    let rows = query_rows(
        &deps.db,
        "select w.card_id, w.sold_qty_7d, w.listed_now, w.sell_through, \
                w.median_sold_eur, w.sold_value_eur_7d, s.name, s.set_name, s.artist \
           from marketplace_card_weights w \
           left join marketplace_search_candidates s on s.card_id = w.card_id \
          where w.sold_qty_7d > 0 order by w.sold_qty_7d desc limit $1",
        &[SqlParam::Int(limit)],
    )
    .await?;
    Ok(json!({
        "status": "ok",
        "window": "7d",
        "cards": rows.iter().map(|row| json!({
            "cardId": field_str(row, "card_id"),
            "name": field_str(row, "name"),
            "setName": field_str(row, "set_name"),
            "artist": field_str(row, "artist"),
            "soldQty7d": row.get("sold_qty_7d").and_then(Json::as_f64).unwrap_or(0.0),
            "listedNow": row.get("listed_now").and_then(Json::as_f64).unwrap_or(0.0),
            "sellThrough": round2_or_none(row.get("sell_through").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
            "medianSoldEur": round2_or_none(row.get("median_sold_eur").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
            "soldValueEur7d": round2_or_none(row.get("sold_value_eur_7d").and_then(Json::as_f64).unwrap_or(f64::NAN)).map(js_num),
        })).collect::<Vec<_>>(),
    }))
}

/// `plausibleSold(soldExpr, ratioParam)` — an outrageous "sale" is a pulled
/// placeholder listing, not a comp.
fn plausible_sold(sold_expr: &str, ratio_param: &str) -> String {
    format!(
        "(({sold_expr} <= asks.ask_pkn * {ratio_param} \
          and ({sold_expr} < {SOLD_HIGH_VALUE_PKN} or {sold_expr} <= asks.ask_pkn * {SOLD_HIGH_VALUE_MAX_TO_ASK})) \
          or (asks.ask_pkn is null and {sold_expr} < {SOLD_UNVERIFIED_MAX_PKN}))"
    )
}

/// `normalizeRarity(value)`.
pub fn normalize_rarity(value: &str) -> String {
    use crate::domain::poko_market_math::clean_text as clean;
    let text = clean(value, 60);
    if text.is_empty() {
        return String::new();
    }
    let aliases: [(Regex, &str); 5] = [
        (Regex::new(r"(?i)^(sir|sar|special (illustration|art) rare)s?$").expect("sir"), "Special Illustration Rare"),
        (Regex::new(r"(?i)^(ir|ar|illustration rare|art rare)s?$").expect("ir"), "Illustration Rare"),
        (Regex::new(r"(?i)^(ur|ultra rare)s?$").expect("ur"), "Ultra Rare"),
        (Regex::new(r"(?i)^(hr|hyper rare)s?$").expect("hr"), "Hyper Rare"),
        (Regex::new(r"(?i)^(sr|secret rare)s?$").expect("sr"), "Secret Rare"),
    ];
    for (pattern, label) in &aliases {
        if pattern.is_match(&text) {
            return (*label).to_string();
        }
    }
    text
}

/// `setTokens(value)`.
pub fn set_tokens(value: &str) -> Vec<String> {
    use crate::domain::poko_market_math::stopwords;
    let stripped = Regex::new(r"[,.!?;:()]+").expect("punct regex");
    let filler = Regex::new(r"(?i)^(set|expansion|espansione|sales|vendite|sold|venduto|venduti)$")
        .expect("filler regex");
    stripped
        .replace_all(&clean_text(value, 80), " ")
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|token| {
            token.len() >= 2 && !stopwords().contains(*token) && !filler.is_match(token)
        })
        .map(str::to_string)
        .collect()
}

/// `eraForCode(code)` — the series prefix of an expansion code.
pub fn era_for_code(code: &str) -> Option<&'static str> {
    let lowered = code.to_ascii_lowercase();
    let prefix: String = lowered
        .chars()
        .take_while(|character| !character.is_ascii_digit())
        .collect();
    if prefix.is_empty() {
        return None;
    }
    const TABLE: [(&str, &str); 14] = [
        (r"^tk-bw", "Black & White"),
        (r"^tk-dp", "Diamond & Pearl"),
        (r"^tk-hs", "HeartGold & SoulSilver"),
        (r"^tk-xy", "XY"),
        (r"^(base|gym|neo|ecard|si|web|vs|e)$", "Wizards of the Coast"),
        (r"^(ex|pop|tk|pcg|adv)$", "EX"),
        (r"^(dp|pt|pl|dpbp)$", "Diamond & Pearl"),
        (r"^(hgss|col|l|ll|hsp)$", "HeartGold & SoulSilver"),
        (r"^(bw|dv)$", "Black & White"),
        (r"^(xy|xya|g|dc|cp)$", "XY"),
        (r"^(sm|sma|smp|det|csm)$", "Sun & Moon"),
        (r"^(swsh|cel|pgo|ru|s|sh|sp|sj|sld|sll|sn|spz|spd|cs|cbb)$", "Sword & Shield"),
        (r"^(sv|sve|zsv|rsv|csv)", "Scarlet & Violet"),
        (r"^(me|mee|m|mc)$", "Mega Evolution"),
    ];
    for (pattern, era) in TABLE {
        if Regex::new(pattern).expect("era regex").is_match(&prefix) {
            return Some(era);
        }
    }
    None
}

/// `NATIONALITY_BY_LANGUAGE`.
pub fn nationality_for_language(code: &str) -> Option<&'static str> {
    match code {
        "JP" => Some("japanese"),
        "ZH" | "ZHT" => Some("chinese"),
        "KO" => Some("korean"),
        _ => None,
    }
}

/// A tiny extension so `""` can fall back to a default.
trait IfEmpty {
    fn if_empty(self, fallback: &'static str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &'static str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}


async fn top_movers(deps: &MarketDeps, params: &Json) -> Result<Json> {
    use crate::domain::poko_market_math::stopwords;
    let subject = {
        let primary = param_string(params, "subject", 80);
        if primary.is_empty() {
            param_string(params, "query", 80)
        } else {
            primary
        }
    };
    let days = bounded(params, "days", 30.0, 7.0, 90.0) as i64;
    let limit = bounded(params, "limit", 5.0, 1.0, 10.0) as usize;
    let direction_raw = param_string(params, "direction", 12);
    let down = Regex::new(r"(?i)^(down|fall|falling|drop|losers?)$")
        .expect("direction regex")
        .is_match(&direction_raw);
    let direction = if down { "down" } else { "up" };
    let punct = Regex::new(r"[,.!?;:()]+").expect("punct regex");
    let tokens: Vec<String> = punct
        .replace_all(&subject.to_ascii_lowercase(), " ")
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !stopwords().contains(*token))
        .map(str::to_string)
        .collect();
    if !subject.is_empty() && tokens.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "subject has no searchable words" }));
    }

    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<SqlParam> = vec![
        SqlParam::Int(days),
        SqlParam::Float(MOVERS_MIN_PRICE_PKN),
    ];
    for token in &tokens {
        values.push(SqlParam::Text(format!("%{}%", escape_like(token))));
        conditions.push(format!("s.search_text ilike ${}", values.len()));
    }
    let token_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("and {}", conditions.join(" and "))
    };
    let sql = format!(
        "with cands as ( \
           select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, \
                  coalesce(nullif(c.card_number, ''), '') as card_number, s.ct_id as blueprint_id \
             from marketplace_search_candidates s \
             left join marketplace_cards c on c.card_id = s.card_id \
            where s.item_kind <> 'product' and s.ct_id is not null {token_clause} \
            order by s.search_weight desc nulls last, s.name limit {MOVERS_MAX_CANDIDATES} \
         ), series as ( \
           select a.blueprint_id, (a.refreshed_at at time zone 'utc')::date as observed_day, \
                  a.refreshed_at, a.min_price_pkn as px \
             from cardtrader_blueprint_daily_analytics a \
             join cands on cands.blueprint_id = a.blueprint_id \
            where a.observed_day >= current_date - ($1::int || ' days')::interval \
              and (a.refreshed_at at time zone 'utc')::date >= current_date - ($1::int || ' days')::interval \
              and a.min_price_pkn > 0 and a.listing_count > 0 \
         ), ends as ( \
           select blueprint_id, \
                  (array_agg(px order by refreshed_at asc))[1] as start_px, \
                  min(observed_day) as start_day, \
                  (array_agg(px order by refreshed_at desc))[1] as end_px, \
                  max(observed_day) as end_day, count(*)::int as points \
             from series group by blueprint_id \
         ) \
         select cands.card_id, cands.ct_id, cands.name, cands.set_name, cands.artist, cands.item_kind, \
                cands.card_number, ends.start_px, ends.start_day, ends.end_px, ends.end_day, ends.points \
           from ends join cands on cands.blueprint_id = ends.blueprint_id \
          where ends.points >= 2 and ends.end_day > ends.start_day \
            and greatest(ends.start_px, ends.end_px) >= $2"
    );
    let rows = query_rows(&deps.db, &sql, &values).await?;

    struct Mover {
        body: Json,
        change_pct: f64,
    }
    let mut movers: Vec<Mover> = Vec::new();
    for row in &rows {
        let start = row.get("start_px").and_then(Json::as_f64).unwrap_or(0.0);
        let end = row.get("end_px").and_then(Json::as_f64).unwrap_or(f64::NAN);
        if !(start > 0.0) || !end.is_finite() {
            continue;
        }
        let from_ask = round2(start);
        let to_ask = round2(end);
        if from_ask.max(to_ask) < MOVERS_MIN_PRICE_PKN {
            continue;
        }
        let change_pct = ((end - start) / start * 1000.0).round() / 10.0;
        if (direction == "up" && !(change_pct > 0.0)) || (direction == "down" && !(change_pct < 0.0)) {
            continue;
        }
        let mut body = candidate_from_row(row)
            .as_object()
            .cloned()
            .unwrap_or_default();
        body.insert("fromDay".into(), day_of(row.get("start_day")).map(|day| json!(day)).unwrap_or(Json::Null));
        body.insert("toDay".into(), day_of(row.get("end_day")).map(|day| json!(day)).unwrap_or(Json::Null));
        body.insert("fromAsk".into(), js_num(from_ask));
        body.insert("toAsk".into(), js_num(to_ask));
        body.insert(
            "fromAskEur".into(),
            round2_or_none(start * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
        );
        body.insert(
            "toAskEur".into(),
            round2_or_none(end * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
        );
        body.insert("changePct".into(), js_num(change_pct));
        body.insert(
            "observations".into(),
            json!(row.get("points").and_then(Json::as_i64).unwrap_or(0)),
        );
        movers.push(Mover { body: Json::Object(body), change_pct });
    }
    movers.sort_by(|a, b| {
        if direction == "up" {
            b.change_pct.partial_cmp(&a.change_pct).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            a.change_pct.partial_cmp(&b.change_pct).unwrap_or(std::cmp::Ordering::Equal)
        }
    });
    movers.truncate(limit);

    let mut base = Map::new();
    if !subject.is_empty() {
        base.insert("subject".into(), json!(subject));
    }
    base.insert("direction".into(), json!(direction));
    base.insert(
        "window".into(),
        json!({ "days": days, "from": deps.days_ago(days), "to": deps.days_ago(0) }),
    );
    base.insert("basis".into(), json!("daily lowest listed ask on the actual UTC refresh date, all conditions/languages; asks are not confirmed sales"));
    base.insert("priceUnit".into(), json!("PKN"));
    base.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    base.insert("minPricePkn".into(), json!(MOVERS_MIN_PRICE_PKN));
    base.insert(
        "minPriceEur".into(),
        js_num(round2(MOVERS_MIN_PRICE_PKN * PKN_EUR_RATE)),
    );
    base.insert("pricedCards".into(), json!(rows.len()));
    if movers.is_empty() {
        // Always 200: "nothing moved" is an answer, not a lookup failure.
        base.insert("status".into(), json!("ok"));
        base.insert("movers".into(), json!([]));
        base.insert(
            "note".into(),
            json!(if rows.is_empty() {
                format!(
                    "No {} cards above the price floor have ask history in the last {days} days.",
                    if subject.is_empty() { "catalog" } else { &subject }
                )
            } else {
                format!(
                    "No {} card moved {direction} in the last {days} days.",
                    if subject.is_empty() { "catalog" } else { &subject }
                )
            }),
        );
        return Ok(Json::Object(base));
    }
    base.insert("status".into(), json!("ok"));
    base.insert(
        "movers".into(),
        Json::Array(movers.into_iter().map(|mover| mover.body).collect()),
    );
    Ok(Json::Object(base))
}

async fn top_sellers(deps: &MarketDeps, params: &Json) -> Result<Json> {
    use crate::domain::poko_market_math::stopwords;
    let days = bounded(params, "days", 7.0, 1.0, 30.0) as i64;
    let limit = bounded(params, "limit", 10.0, 1.0, 20.0) as i64;
    let language_raw = param_string(params, "language", 40);
    let language = if language_raw.is_empty() {
        None
    } else {
        Some(normalize_language(&language_raw).code)
    };
    let rarity = normalize_rarity(&param_string(params, "rarity", 200));
    let min_eur = param_number(params, "minPriceEur").unwrap_or(0.0);
    let max_eur = param_number(params, "maxPriceEur").unwrap_or(0.0);
    let min_price_pkn = {
        let explicit = param_number(params, "minPricePkn").unwrap_or(0.0);
        if explicit > 0.0 {
            explicit
        } else if min_eur > 0.0 {
            min_eur / PKN_EUR_RATE
        } else {
            0.0
        }
    };
    let max_price_pkn = {
        let explicit = param_number(params, "maxPricePkn").unwrap_or(0.0);
        if explicit > 0.0 {
            Some(explicit)
        } else if max_eur > 0.0 {
            Some(max_eur / PKN_EUR_RATE)
        } else {
            None
        }
    };
    let subject = {
        let primary = param_string(params, "subject", 80);
        if primary.is_empty() {
            param_string(params, "query", 80)
        } else {
            primary
        }
    };
    let punct = Regex::new(r"[,.!?;:()]+").expect("punct regex");
    let tokens: Vec<String> = punct
        .replace_all(&subject.to_ascii_lowercase(), " ")
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !stopwords().contains(*token))
        .map(str::to_string)
        .collect();

    let mut values: Vec<SqlParam> = vec![
        SqlParam::Int(days),
        match language {
            Some(code) => SqlParam::Text(code.to_string()),
            None => SqlParam::Null,
        },
        SqlParam::Float(min_price_pkn),
        match max_price_pkn {
            Some(value) => SqlParam::Float(value),
            None => SqlParam::Null,
        },
        SqlParam::Int(limit),
        if rarity.is_empty() {
            SqlParam::Null
        } else {
            SqlParam::Text(rarity.clone())
        },
        SqlParam::Float(TOP_SELLERS_MAX_SOLD_TO_ASK),
    ];
    let mut subject_conditions: Vec<String> = Vec::new();
    for token in &tokens {
        values.push(SqlParam::Text(format!("%{}%", escape_like(token))));
        subject_conditions.push(format!("s.search_text ilike ${}", values.len()));
    }
    let subject_clause = if subject_conditions.is_empty() {
        String::new()
    } else {
        format!("and {}", subject_conditions.join(" and "))
    };
    let sql = format!(
        "with sold as ( \
           select blueprint_id, sum(sold_qty)::int as sold_qty, \
                  count(distinct observed_day)::int as sale_days, \
                  percentile_cont(0.5) within group (order by median_pkn) as median_pkn, \
                  max(observed_day) as last_sale_day \
             from cardtrader_sold_daily \
            where observed_day >= current_date - ($1::int || ' days')::interval \
              and sold_qty > 0 and not graded and ($2::text is null or language = $2) \
            group by blueprint_id \
         ), asks as ( \
           select blueprint_id, \
                  percentile_cont(0.5) within group (order by coalesce(min_price_pkn, median_price_pkn)) as ask_pkn \
             from cardtrader_blueprint_daily_analytics \
            where observed_day >= current_date - interval '{SOLD_REFERENCE_ASK_DAYS} days' \
              and coalesce(min_price_pkn, median_price_pkn) > 0 \
              and blueprint_id in (select blueprint_id from sold) \
            group by blueprint_id \
         ) \
         select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, s.card_number, \
                sold.sold_qty, sold.sale_days, sold.median_pkn, sold.last_sale_day, asks.ask_pkn \
           from sold \
           join marketplace_search_candidates s on s.ct_id = sold.blueprint_id and s.item_kind = 'single' \
           left join asks on asks.blueprint_id = sold.blueprint_id \
          where sold.median_pkn >= $3 \
            and ($4::numeric is null or sold.median_pkn <= $4) \
            and {} \
            and ($6::text is null \
                 or lower(split_part(s.card_number, ' | ', 1)) = lower($6) \
                 or lower(s.rarity) = lower($6)) {subject_clause} \
          order by sold.sold_qty desc, sold.sale_days desc limit $5",
        plausible_sold("sold.median_pkn", "$7")
    );
    let rows = query_rows(&deps.db, &sql, &values).await?;

    let cards: Vec<Json> = rows
        .iter()
        .map(|row| {
            let mut card = candidate_from_row(row)
                .as_object()
                .cloned()
                .unwrap_or_default();
            let median = row.get("median_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN);
            card.insert(
                "soldQty".into(),
                json!(row.get("sold_qty").and_then(Json::as_i64).unwrap_or(0)),
            );
            card.insert(
                "saleDays".into(),
                json!(row.get("sale_days").and_then(Json::as_i64).unwrap_or(0)),
            );
            card.insert(
                "medianSoldPkn".into(),
                round2_or_none(median).map(js_num).unwrap_or(Json::Null),
            );
            card.insert(
                "medianSoldEur".into(),
                round2_or_none(median * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
            );
            card.insert(
                "currentAskPkn".into(),
                row.get("ask_pkn")
                    .and_then(Json::as_f64)
                    .and_then(round2_or_none)
                    .map(js_num)
                    .unwrap_or(Json::Null),
            );
            card.insert(
                "lastSaleDay".into(),
                day_of(row.get("last_sale_day")).map(|day| json!(day)).unwrap_or(Json::Null),
            );
            Json::Object(card)
        })
        .collect();

    let mut filters = Map::new();
    filters.insert("language".into(), json!(language.unwrap_or("all")));
    if !rarity.is_empty() {
        filters.insert("rarity".into(), json!(rarity));
    }
    if !subject.is_empty() {
        filters.insert("subject".into(), json!(subject));
    }
    if min_price_pkn > 0.0 {
        filters.insert("minPricePkn".into(), js_num(min_price_pkn));
    }
    if let Some(max_price_pkn) = max_price_pkn {
        filters.insert("maxPricePkn".into(), js_num(max_price_pkn));
    }
    let mut base = Map::new();
    base.insert(
        "window".into(),
        json!({ "days": days, "from": deps.days_ago(days), "to": deps.days_ago(0) }),
    );
    base.insert("basis".into(), json!("confirmed CardTrader sales (ungraded), ranked by units sold; saleDays = days with at least one sale"));
    base.insert("priceUnit".into(), json!("PKN"));
    base.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    base.insert("filters".into(), Json::Object(filters));
    base.insert("status".into(), json!("ok"));
    if cards.is_empty() {
        base.insert("cards".into(), json!([]));
        base.insert(
            "note".into(),
            json!(format!("No ungraded single matching these filters sold in the last {days} days.")),
        );
        return Ok(Json::Object(base));
    }
    base.insert("cards".into(), Json::Array(cards));
    Ok(Json::Object(base))
}

async fn set_sales(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let tokens = {
        let primary = param_string(params, "setName", 80);
        let secondary = param_string(params, "set", 80);
        let tertiary = param_string(params, "query", 80);
        let quaternary = param_string(params, "subject", 80);
        let chosen = if !primary.is_empty() {
            primary
        } else if !secondary.is_empty() {
            secondary
        } else if !tertiary.is_empty() {
            tertiary
        } else {
            quaternary
        };
        set_tokens(&chosen)
    };
    if tokens.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "setName required" }));
    }
    let days = bounded(params, "days", 30.0, 1.0, 90.0) as i64;
    let limit = bounded(params, "limit", 10.0, 1.0, 20.0) as usize;
    let language_raw = param_string(params, "language", 40);
    let language = if language_raw.is_empty() {
        None
    } else {
        Some(normalize_language(&language_raw).code)
    };

    let mut values: Vec<SqlParam> = vec![
        SqlParam::Int(days),
        match language {
            Some(code) => SqlParam::Text(code.to_string()),
            None => SqlParam::Null,
        },
        SqlParam::Float(TOP_SELLERS_MAX_SOLD_TO_ASK),
    ];
    let mut set_conditions: Vec<String> = Vec::new();
    for token in &tokens {
        values.push(SqlParam::Text(format!("%{}%", escape_like(token))));
        set_conditions.push(format!("c.set_name ilike ${}", values.len()));
    }
    let sql = format!(
        "with cards as ( \
           select c.card_id, c.ct_id, c.name, c.set_name, c.artist, c.item_kind, c.card_number \
             from marketplace_search_candidates c \
            where c.item_kind = 'single' and {} limit 4000 \
         ), set_sold as ( \
           select d.blueprint_id, sum(d.sold_qty)::int as sold_qty, \
                  sum(d.sold_qty * d.median_pkn) as value_pkn, \
                  percentile_cont(0.5) within group (order by d.median_pkn) as median_pkn, \
                  max(d.observed_day) as last_sale_day \
             from cardtrader_sold_daily d \
            where d.blueprint_id in (select ct_id from cards where ct_id is not null) \
              and d.observed_day >= current_date - ($1::int || ' days')::interval \
              and d.sold_qty > 0 and not d.graded and ($2::text is null or d.language = $2) \
            group by d.blueprint_id \
         ), asks as ( \
           select a.blueprint_id, \
                  percentile_cont(0.5) within group (order by coalesce(a.min_price_pkn, a.median_price_pkn)) as ask_pkn \
             from cardtrader_blueprint_daily_analytics a \
            where a.observed_day >= current_date - interval '{SOLD_REFERENCE_ASK_DAYS} days' \
              and coalesce(a.min_price_pkn, a.median_price_pkn) > 0 \
              and a.blueprint_id in (select blueprint_id from set_sold) \
            group by a.blueprint_id \
         ) \
         select cards.card_id, cards.ct_id, cards.name, cards.set_name, cards.artist, cards.item_kind, cards.card_number, \
                set_sold.sold_qty, set_sold.value_pkn, set_sold.median_pkn, set_sold.last_sale_day \
           from set_sold join cards on cards.ct_id = set_sold.blueprint_id \
           left join asks on asks.blueprint_id = set_sold.blueprint_id \
          where {}",
        set_conditions.join(" and "),
        plausible_sold("set_sold.median_pkn", "$3")
    );
    let rows = query_rows(&deps.db, &sql, &values).await?;

    let cards: Vec<Json> = rows
        .iter()
        .map(|row| {
            let mut card = candidate_from_row(row)
                .as_object()
                .cloned()
                .unwrap_or_default();
            card.insert(
                "soldQty".into(),
                json!(row.get("sold_qty").and_then(Json::as_i64).unwrap_or(0)),
            );
            card.insert(
                "medianSoldPkn".into(),
                round2_or_none(row.get("median_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN))
                    .map(js_num)
                    .unwrap_or(Json::Null),
            );
            card.insert(
                "soldValuePkn".into(),
                round2_or_none(row.get("value_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN))
                    .map(js_num)
                    .unwrap_or(Json::Null),
            );
            card.insert(
                "lastSaleDay".into(),
                day_of(row.get("last_sale_day")).map(|day| json!(day)).unwrap_or(Json::Null),
            );
            Json::Object(card)
        })
        .collect();

    let mut seen: Vec<String> = Vec::new();
    for card in &cards {
        let name = field_str(card, "setName");
        if !name.is_empty() && !seen.contains(&name) {
            seen.push(name);
        }
    }
    let total_units: i64 = cards
        .iter()
        .map(|card| card.get("soldQty").and_then(Json::as_i64).unwrap_or(0))
        .sum();
    let total_value: f64 = cards
        .iter()
        .map(|card| card.get("soldValuePkn").and_then(Json::as_f64).unwrap_or(0.0))
        .sum();

    let mut by_units = cards.clone();
    by_units.sort_by(|a, b| {
        let left = a.get("soldQty").and_then(Json::as_i64).unwrap_or(0);
        let right = b.get("soldQty").and_then(Json::as_i64).unwrap_or(0);
        right.cmp(&left)
    });
    let mut by_value = cards.clone();
    by_value.sort_by(|a, b| {
        let left = a.get("medianSoldPkn").and_then(Json::as_f64).unwrap_or(0.0);
        let right = b.get("medianSoldPkn").and_then(Json::as_f64).unwrap_or(0.0);
        right.partial_cmp(&left).unwrap_or(std::cmp::Ordering::Equal)
    });

    let joined = tokens.join(" ");
    Ok(json!({
        "status": "ok",
        "today": deps.today(),
        "priceUnit": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "window": { "days": days, "from": deps.days_ago(days), "to": deps.days_ago(0) },
        "filters": { "set": joined, "language": language.unwrap_or("all") },
        "matchedSets": seen.iter().take(8).cloned().collect::<Vec<_>>(),
        "totals": {
            "unitsSold": total_units,
            "soldValuePkn": js_num(round2(total_value)),
            "soldValueEur": round2_or_none(total_value * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
            "distinctCardsSold": cards.len(),
        },
        "topByUnits": by_units.iter().take(limit).cloned().collect::<Vec<_>>(),
        "topByValue": by_value.iter().take(limit).cloned().collect::<Vec<_>>(),
        "note": if cards.is_empty() {
            json!(format!("No ungraded sale in a set matching \"{joined}\" in the last {days} days."))
        } else if seen.len() > 1 {
            json!("Several expansions matched; ask which one if the user meant a single set.")
        } else {
            Json::Null
        },
        "basis": "CardTrader inferred sales (cardtrader_sold_daily), ungraded, all variants; value = units × daily median",
    }))
}

async fn recent_sales(deps: &MarketDeps, params: &Json) -> Result<Json> {
    use crate::domain::poko_market_math::stopwords;
    let days = bounded(params, "days", 3.0, 1.0, 30.0) as i64;
    let limit = bounded(params, "limit", 10.0, 1.0, 25.0) as i64;
    let sort_raw = param_string(params, "sort", 20);
    let recent = Regex::new(r"(?i)^(recent|latest|date|ultime|recenti)$")
        .expect("sort regex")
        .is_match(&sort_raw);
    let sort = if recent { "recent" } else { "price" };
    let language_raw = param_string(params, "language", 40);
    let language = if language_raw.is_empty() {
        None
    } else {
        Some(normalize_language(&language_raw).code)
    };
    let graded = sold_flag(params.get("graded")) == Some(true);
    let min_eur = param_number(params, "minPriceEur").unwrap_or(0.0);
    let min_price_pkn = {
        let explicit = param_number(params, "minPricePkn").unwrap_or(0.0);
        if explicit > 0.0 {
            explicit
        } else if min_eur > 0.0 {
            min_eur / PKN_EUR_RATE
        } else {
            0.0
        }
    };
    let subject = {
        let primary = param_string(params, "subject", 80);
        if primary.is_empty() {
            param_string(params, "query", 80)
        } else {
            primary
        }
    };
    let punct = Regex::new(r"[,.!?;:()]+").expect("punct regex");
    let tokens: Vec<String> = punct
        .replace_all(&subject.to_ascii_lowercase(), " ")
        .split_whitespace()
        .filter(|token| token.len() >= 2 && !stopwords().contains(*token))
        .map(str::to_string)
        .collect();

    let mut values: Vec<SqlParam> = vec![
        SqlParam::Int(days),
        match language {
            Some(code) => SqlParam::Text(code.to_string()),
            None => SqlParam::Null,
        },
        SqlParam::Bool(graded),
        SqlParam::Float(min_price_pkn),
        SqlParam::Float(TOP_SELLERS_MAX_SOLD_TO_ASK),
        SqlParam::Int(limit),
    ];
    let mut subject_conditions: Vec<String> = Vec::new();
    for token in &tokens {
        values.push(SqlParam::Text(format!("%{}%", escape_like(token))));
        subject_conditions.push(format!("s.search_text ilike ${}", values.len()));
    }
    let subject_clause = if subject_conditions.is_empty() {
        String::new()
    } else {
        format!("and {}", subject_conditions.join(" and "))
    };
    let order = if sort == "recent" {
        "recent.observed_day desc, recent.median_pkn desc"
    } else {
        "recent.median_pkn desc, recent.observed_day desc"
    };
    let sql = format!(
        "with recent as ( \
           select d.blueprint_id, d.observed_day, d.condition, d.language, d.reverse, d.first_edition, d.graded, \
                  d.sold_qty, d.median_pkn, d.max_pkn \
             from cardtrader_sold_daily d \
            where d.observed_day >= current_date - ($1::int || ' days')::interval \
              and d.sold_qty > 0 and d.graded = $3 and ($2::text is null or d.language = $2) \
              and d.median_pkn >= $4 \
         ), asks as ( \
           select a.blueprint_id, \
                  percentile_cont(0.5) within group (order by coalesce(a.min_price_pkn, a.median_price_pkn)) as ask_pkn \
             from cardtrader_blueprint_daily_analytics a \
            where a.observed_day >= current_date - interval '{SOLD_REFERENCE_ASK_DAYS} days' \
              and coalesce(a.min_price_pkn, a.median_price_pkn) > 0 \
              and a.blueprint_id in (select blueprint_id from recent) \
            group by a.blueprint_id \
         ) \
         select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, s.card_number, \
                recent.observed_day, recent.condition, recent.language, recent.reverse, recent.first_edition, \
                recent.graded, recent.sold_qty, recent.median_pkn, asks.ask_pkn \
           from recent \
           join marketplace_search_candidates s on s.ct_id = recent.blueprint_id and s.item_kind = 'single' \
           left join asks on asks.blueprint_id = recent.blueprint_id \
          where {} {subject_clause} order by {order} limit $6",
        plausible_sold("recent.median_pkn", "$5")
    );
    let rows = query_rows(&deps.db, &sql, &values).await?;

    let sales: Vec<Json> = rows
        .iter()
        .map(|row| {
            let mut sale = candidate_from_row(row)
                .as_object()
                .cloned()
                .unwrap_or_default();
            let median = row.get("median_pkn").and_then(Json::as_f64).unwrap_or(f64::NAN);
            let ask = row.get("ask_pkn").and_then(Json::as_f64).unwrap_or(0.0);
            sale.insert(
                "day".into(),
                day_of(row.get("observed_day")).map(|day| json!(day)).unwrap_or(Json::Null),
            );
            sale.insert("condition".into(), json!(field_str(row, "condition")));
            sale.insert(
                "language".into(),
                json!(field_str(row, "language").to_ascii_uppercase()),
            );
            sale.insert(
                "variant".into(),
                json!(facet_label(Facet {
                    reverse: row.get("reverse").and_then(Json::as_bool).unwrap_or(false),
                    first_edition: row.get("first_edition").and_then(Json::as_bool).unwrap_or(false),
                    graded: row.get("graded").and_then(Json::as_bool).unwrap_or(false),
                    explicit: false,
                })),
            );
            sale.insert(
                "units".into(),
                json!(row.get("sold_qty").and_then(Json::as_i64).unwrap_or(0)),
            );
            sale.insert(
                "pricePkn".into(),
                round2_or_none(median).map(js_num).unwrap_or(Json::Null),
            );
            sale.insert(
                "priceEur".into(),
                round2_or_none(median * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
            );
            sale.insert(
                "typicalAskPkn".into(),
                round2_or_none(ask).map(js_num).unwrap_or(Json::Null),
            );
            if ask > 0.0 && median > ask * RECENT_SALE_VERIFY_RATIO {
                sale.insert("unverified".into(), json!(true));
            }
            Json::Object(sale)
        })
        .collect();

    let mut filters = Map::new();
    filters.insert("sort".into(), json!(sort));
    filters.insert("language".into(), json!(language.unwrap_or("all")));
    filters.insert("graded".into(), json!(graded));
    if !tokens.is_empty() {
        filters.insert("subject".into(), json!(tokens.join(" ")));
    }
    if min_price_pkn > 0.0 {
        filters.insert("minPricePkn".into(), js_num(min_price_pkn));
    }
    Ok(json!({
        "status": "ok",
        "today": deps.today(),
        "priceUnit": "PKN",
        "pknEurRate": PKN_EUR_RATE,
        "window": { "days": days, "from": deps.days_ago(days), "to": deps.days_ago(0) },
        "filters": Json::Object(filters),
        "sales": sales.clone(),
        "note": if sales.is_empty() {
            format!("No sale matching these filters in the last {days} days.")
        } else {
            "Each row is one day × condition × language slice; price = that day's median sale price. unverified = more than 3× the printing's typical 14-day ask (may be a pulled listing, not a sale) — caveat it.".to_string()
        },
        "basis": "CardTrader inferred sales (cardtrader_sold_daily); outlier lots above 20× the recent ask dropped",
    }))
}

async fn artist_cards(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let mut artist_input = param_string(params, "artist", 80);
    let card_id = param_string(params, "cardId", 20);
    let mut from_card: Option<Json> = None;
    if artist_input.is_empty() && !card_id.is_empty() && card_id.bytes().all(|byte| byte.is_ascii_digit()) {
        let rows = query_rows(
            &deps.db,
            "select artist, name, set_name from marketplace_search_candidates where card_id = $1 limit 1",
            &[SqlParam::Text(card_id.clone())],
        )
        .await?;
        let Some(row) = rows.first() else {
            return Ok(json!({ "status": "not_found", "error": "no artist recorded for that card", "cardId": card_id }));
        };
        artist_input = clean_text(&field_str(row, "artist"), 80);
        if artist_input.is_empty() {
            return Ok(json!({ "status": "not_found", "error": "no artist recorded for that card", "cardId": card_id }));
        }
        let name = field_str(row, "name");
        let set_name = field_str(row, "set_name");
        from_card = Some(json!({
            "cardId": card_id,
            "name": name,
            "setName": set_name,
            "illustrator": artist_input,
            "note": format!(
                "{}{} is illustrated by {artist_input} (Pokoin catalog).",
                if name.is_empty() { "This card".to_string() } else { name.clone() },
                if set_name.is_empty() { String::new() } else { format!(" ({set_name})") }
            ),
        }));
    }
    if artist_input.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "artist or cardId required" }));
    }

    let artist_rows = query_rows(
        &deps.db,
        "select artist, count(*)::int as cards from marketplace_search_candidates \
          where item_kind <> 'product' and artist <> '' and (artist = $1 or artist ilike $2) \
          group by artist order by (artist = $1) desc, cards desc limit 5",
        &[
            SqlParam::Text(artist_input.clone()),
            SqlParam::Text(fuzzy_artist_pattern(&artist_input)),
        ],
    )
    .await?;
    if artist_rows.is_empty() {
        return Ok(json!({ "status": "not_found", "error": "no artist matches that name" }));
    }
    let exact = artist_rows.iter().find(|row| {
        field_str(row, "artist").to_ascii_lowercase() == artist_input.to_ascii_lowercase()
    });
    if exact.is_none() && artist_rows.len() > 1 {
        return Ok(json!({
            "status": "ambiguous",
            "artists": artist_rows.iter().map(|row| json!({
                "artist": field_str(row, "artist"),
                "cards": row.get("cards").and_then(Json::as_i64).unwrap_or(0),
            })).collect::<Vec<_>>(),
            "note": "Ask one concise clarification question; do not silently resolve.",
        }));
    }
    let chosen = exact.unwrap_or(&artist_rows[0]);
    let artist = field_str(chosen, "artist");
    let artist_card_count = chosen.get("cards").and_then(Json::as_i64).unwrap_or(0);
    let sort_raw = param_string(params, "sort", 20);
    let sort = if Regex::new(r"(?i)^(cheap|cheapest|asc|low)$")
        .expect("sort regex")
        .is_match(&sort_raw)
    {
        "cheapest"
    } else if Regex::new(r"(?i)^(sold|sales|popular|volume)$")
        .expect("sort regex")
        .is_match(&sort_raw)
    {
        "sold"
    } else {
        "expensive"
    };
    let limit = bounded(params, "limit", 10.0, 1.0, 20.0) as usize;
    let language_raw = param_string(params, "language", 40);
    let language = if language_raw.is_empty() {
        None
    } else {
        Some(normalize_language(&language_raw).code)
    };

    let rows = query_rows(
        &deps.db,
        &format!(
            "with art as ( \
               select s.card_id, s.ct_id, s.name, s.set_name, s.artist, s.item_kind, s.card_number, \
                      s.ct_id as blueprint_id \
                 from marketplace_search_candidates s \
                where s.artist = $1 and s.item_kind = 'single' and s.ct_id is not null \
             ), sold as ( \
               select d.blueprint_id, sum(d.sold_qty)::int as sold_qty, \
                      percentile_cont(0.5) within group (order by d.median_pkn) as median_pkn, \
                      max(d.observed_day) as last_sale_day \
                 from cardtrader_sold_daily d join art on art.blueprint_id = d.blueprint_id \
                where d.observed_day >= current_date - interval '90 days' \
                  and d.sold_qty > 0 and not d.graded and ($2::text is null or d.language = $2) \
                group by d.blueprint_id \
             ), asks as ( \
               select a.blueprint_id, \
                      percentile_cont(0.5) within group (order by coalesce(a.min_price_pkn, a.median_price_pkn)) as ask_pkn, \
                      (array_agg(coalesce(a.min_price_pkn, a.median_price_pkn) order by a.observed_day desc))[1] as current_ask_pkn \
                 from cardtrader_blueprint_daily_analytics a join art on art.blueprint_id = a.blueprint_id \
                where a.observed_day >= current_date - interval '{SOLD_REFERENCE_ASK_DAYS} days' \
                  and coalesce(a.min_price_pkn, a.median_price_pkn) > 0 \
                group by a.blueprint_id \
             ) \
             select art.card_id, art.ct_id, art.name, art.set_name, art.artist, art.item_kind, art.card_number, \
                    sold.sold_qty, sold.median_pkn, sold.last_sale_day, asks.current_ask_pkn, \
                    (sold.median_pkn is not null and {}) as sold_ok \
               from art left join sold on sold.blueprint_id = art.blueprint_id \
               left join asks on asks.blueprint_id = art.blueprint_id \
              where sold.median_pkn is not null or ($2::text is null and asks.current_ask_pkn > 0)",
            plausible_sold("sold.median_pkn", "$3")
        ),
        &[
            SqlParam::Text(artist.clone()),
            match language {
                Some(code) => SqlParam::Text(code.to_string()),
                None => SqlParam::Null,
            },
            SqlParam::Float(TOP_SELLERS_MAX_SOLD_TO_ASK),
        ],
    )
    .await?;

    struct Priced {
        body: Json,
        price: f64,
        sold_qty: i64,
    }
    let mut priced: Vec<Priced> = Vec::new();
    for row in &rows {
        let sold_ok = row.get("sold_ok").and_then(Json::as_bool).unwrap_or(false)
            && row.get("median_pkn").and_then(Json::as_f64).unwrap_or(0.0) > 0.0;
        let ask = row.get("current_ask_pkn").and_then(Json::as_f64).unwrap_or(0.0);
        // A lone placeholder listing can be the lowest ask, so an unsold card
        // only counts below the unverified cap.
        let ask_ok = language.is_none() && ask > 0.0 && ask < SOLD_UNVERIFIED_MAX_PKN;
        let price_pkn = if sold_ok {
            Some(row.get("median_pkn").and_then(Json::as_f64).unwrap_or(0.0))
        } else if ask_ok {
            Some(ask)
        } else {
            None
        };
        let Some(price_pkn) = price_pkn else {
            continue;
        };
        let sold_qty = if sold_ok {
            row.get("sold_qty").and_then(Json::as_i64).unwrap_or(0)
        } else {
            0
        };
        let mut card = candidate_from_row(row)
            .as_object()
            .cloned()
            .unwrap_or_default();
        card.insert("pricePkn".into(), js_num(round2(price_pkn)));
        card.insert(
            "priceEur".into(),
            round2_or_none(price_pkn * PKN_EUR_RATE).map(js_num).unwrap_or(Json::Null),
        );
        card.insert(
            "priceBasis".into(),
            json!(if sold_ok { "sold_median_90d" } else { "lowest_ask" }),
        );
        card.insert("soldQty90d".into(), json!(sold_qty));
        card.insert(
            "lowestAskPkn".into(),
            round2_or_none(ask).map(js_num).unwrap_or(Json::Null),
        );
        card.insert(
            "lastSaleDay".into(),
            if sold_ok {
                day_of(row.get("last_sale_day")).map(|day| json!(day)).unwrap_or(Json::Null)
            } else {
                Json::Null
            },
        );
        priced.push(Priced {
            body: Json::Object(card),
            price: round2(price_pkn),
            sold_qty,
        });
    }
    priced.sort_by(|a, b| match sort {
        "cheapest" => a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal),
        "sold" => b
            .sold_qty
            .cmp(&a.sold_qty)
            .then_with(|| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal)),
        _ => b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal),
    });
    let cards: Vec<Json> = priced.iter().take(limit).map(|entry| entry.body.clone()).collect();
    let priced_count = rows.len();

    let mut body = Map::new();
    body.insert("status".into(), json!("ok"));
    body.insert("artist".into(), json!(artist));
    if let Some(from_card) = from_card {
        body.insert("fromCard".into(), from_card);
    }
    body.insert("artistCardCount".into(), json!(artist_card_count));
    body.insert("pricedCards".into(), json!(priced_count));
    body.insert("sort".into(), json!(sort));
    body.insert("language".into(), json!(language.unwrap_or("all")));
    body.insert("basis".into(), json!("price = 90-day ungraded sold median (CardTrader) when plausible against the ask history, else the latest lowest ask; priceBasis says which"));
    body.insert("priceUnit".into(), json!("PKN"));
    body.insert("pknEurRate".into(), json!(PKN_EUR_RATE));
    body.insert("cards".into(), Json::Array(cards.clone()));
    if cards.is_empty() {
        body.insert(
            "note".into(),
            json!(format!(
                "No priced {artist} singles{} right now.",
                language.map(|code| format!(" in {code}")).unwrap_or_default()
            )),
        );
    }
    Ok(Json::Object(body))
}

async fn set_info(deps: &MarketDeps, params: &Json) -> Result<Json> {
    let query = {
        let primary = param_string(params, "setName", 80);
        let secondary = param_string(params, "set", 80);
        let tertiary = param_string(params, "query", 80);
        let quaternary = param_string(params, "subject", 80);
        if !primary.is_empty() {
            primary
        } else if !secondary.is_empty() {
            secondary
        } else if !tertiary.is_empty() {
            tertiary
        } else {
            quaternary
        }
    };
    let era = param_string(params, "era", 40);
    let language_raw = param_string(params, "language", 40);
    let language_code = if language_raw.is_empty() {
        None
    } else {
        Some(normalize_language(&language_raw).code)
    };
    let nationality_input = param_string(params, "nationality", 20).to_ascii_lowercase();
    let nationality = if !nationality_input.is_empty() {
        nationality_input
    } else {
        language_code
            .and_then(nationality_for_language)
            .unwrap_or("")
            .to_string()
    };
    let default_limit = if query.is_empty() { 20.0 } else { 5.0 };
    let limit = bounded(params, "limit", default_limit, 1.0, 40.0) as usize;
    if query.is_empty() && era.is_empty() && nationality.is_empty() {
        return Ok(json!({ "status": "invalid", "error": "setName, era or nationality required" }));
    }

    let mut values: Vec<SqlParam> = vec![if nationality.is_empty() {
        SqlParam::Null
    } else {
        SqlParam::Text(nationality.clone())
    }];
    let query_condition = if query.is_empty() {
        String::new()
    } else {
        values.push(SqlParam::Text(query.clone()));
        values.push(SqlParam::Text(format!("%{}%", escape_like(&query))));
        "and (lower(e.name) = lower($2) or lower(e.official_id) = lower($2) \
           or e.name ilike $3 or e.official_name ilike $3 \
           or exists (select 1 from expansion_languages l where l.expansion_id = e.expansion_id and l.localized_name ilike $3) \
           or exists (select 1 from marketplace_expansion_aliases a \
                       where a.expansion_name = e.name and a.alias ilike $3))"
            .to_string()
    };
    let order = if query.is_empty() {
        "e.catalog_card_count desc nulls last, e.name"
    } else {
        "(lower(e.name) = lower($2)) desc, e.catalog_card_count desc nulls last, e.name"
    };
    let sql = format!(
        "select e.expansion_id, e.name, e.official_id, e.official_name, e.nationality, e.kind, e.listed, \
                e.catalog_card_count, \
                (select array_agg(distinct upper(r.language) order by upper(r.language)) \
                   from expansion_release_languages r where r.expansion_id = e.expansion_id) as release_languages, \
                (select jsonb_object_agg(l.language, l.localized_name) \
                   from expansion_languages l where l.expansion_id = e.expansion_id) as localized_names \
           from pokoin_pokemon_expansions e \
          where e.kind in ('official', 'promo', 'subset') \
            and ($1::text is null or e.nationality = $1) {query_condition} \
          order by {order} limit 400"
    );
    let rows = query_rows(&deps.db, &sql, &values).await?;

    let sets: Vec<Json> = rows
        .iter()
        .map(|row| {
            let official_id = field_str(row, "official_id");
            json!({
                "name": field_str(row, "name"),
                "officialName": field_str(row, "official_name"),
                "code": official_id.clone(),
                "era": era_for_code(&official_id),
                "nationality": field_str(row, "nationality"),
                "kind": field_str(row, "kind"),
                "onMarketplace": row.get("listed").and_then(Json::as_bool).unwrap_or(false),
                "cardCount": row.get("catalog_card_count").and_then(Json::as_i64).unwrap_or(0),
                "releaseLanguages": row.get("release_languages").cloned().unwrap_or(json!([])),
                "localizedNames": match row.get("localized_names") {
                    Some(Json::Object(fields)) => Json::Object(fields.clone()),
                    _ => json!({}),
                },
            })
        })
        .filter(|set| {
            era.is_empty()
                || set
                    .get("era")
                    .and_then(Json::as_str)
                    .map(|value| value.to_ascii_lowercase().contains(&era.to_ascii_lowercase()))
                    .unwrap_or(false)
        })
        // Western sets list their release languages; JP/CN nationality is in SQL.
        .filter(|set| {
            if language_code.is_none() || language_code.and_then(nationality_for_language).is_some() {
                return true;
            }
            let code = language_code.unwrap_or("EN");
            set.get("releaseLanguages")
                .and_then(Json::as_array)
                .map(|languages| languages.iter().any(|value| value.as_str() == Some(code)))
                .unwrap_or(false)
        })
        .take(limit)
        .collect();

    if sets.is_empty() {
        return Ok(json!({
            "status": "not_found",
            "error": "no expansion matches",
            "note": "Ask for the exact set name (English, Japanese or localized) or its code.",
        }));
    }
    let mut eras: Vec<&'static str> = Vec::new();
    const ERA_LABELS: [&str; 14] = [
        "Black & White", "Diamond & Pearl", "HeartGold & SoulSilver", "XY",
        "Wizards of the Coast", "EX", "Diamond & Pearl", "HeartGold & SoulSilver",
        "Black & White", "XY", "Sun & Moon", "Sword & Shield", "Scarlet & Violet",
        "Mega Evolution",
    ];
    for label in ERA_LABELS {
        if !eras.contains(&label) {
            eras.push(label);
        }
    }
    let mut filters = Map::new();
    if !query.is_empty() {
        filters.insert("query".into(), json!(query));
    }
    if !era.is_empty() {
        filters.insert("era".into(), json!(era));
    }
    if !nationality.is_empty() {
        filters.insert("nationality".into(), json!(nationality));
    }
    Ok(json!({
        "status": "ok",
        "filters": Json::Object(filters),
        "eras": eras,
        "sets": sets,
    }))
}

// ---------------------------------------------------------------------------
// Dispatch and HTTP
// ---------------------------------------------------------------------------

/// The tool names, in contract order.
pub const TOOLS: [&str; 15] = [
    "resolve_card",
    "card_quote",
    "card_ocr",
    "card_liquidity",
    "collection_quote",
    "suggest_cards",
    "market_snapshot",
    "top_movers",
    "top_sellers",
    "card_sales",
    "deal_check",
    "set_sales",
    "recent_sales",
    "artist_cards",
    "set_info",
];

fn tool_names() -> &'static [&'static str] {
    &TOOLS
}

async fn run_tool(deps: &MarketDeps, tool: &str, params: &Json) -> Result<Json> {
    match tool {
        "resolve_card" => resolve_card(&deps.db, params).await,
        "card_quote" => card_quote(deps, params).await,
        "card_ocr" => card_ocr(deps, params).await,
        "card_liquidity" => card_liquidity(deps, params).await,
        "collection_quote" => collection_quote(deps, params).await,
        "suggest_cards" => suggest_cards(deps, params).await,
        "market_snapshot" => market_snapshot(deps, params).await,
        "top_movers" => top_movers(deps, params).await,
        "top_sellers" => top_sellers(deps, params).await,
        "card_sales" => card_sales(deps, params).await,
        "deal_check" => deal_check(deps, params).await,
        "set_sales" => set_sales(deps, params).await,
        "recent_sales" => recent_sales(deps, params).await,
        "artist_cards" => artist_cards(deps, params).await,
        _ => set_info(deps, params).await,
    }
}

/// The HTTP status a tool's own `status` maps to.
pub fn status_for_tool(status: &str) -> StatusCode {
    match status {
        "invalid" => StatusCode::BAD_REQUEST,
        "not_found" => StatusCode::NOT_FOUND,
        "unsupported" => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::OK,
    }
}

/// The TCGplayer history pool, created lazily and only when configured.
fn tcg_pool() -> Option<MarketplaceDb> {
    static POOL: OnceLock<Option<MarketplaceDb>> = OnceLock::new();
    POOL.get_or_init(|| {
        let url = std::env::var("TCGCSV_DATABASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;
        MarketplaceDb::connect_lazy(&url, 1).ok()
    })
    .clone()
}

/// A JSON response with no CORS headers: this is a service-to-service API.
fn market_json(status: StatusCode, body: Json) -> Response {
    json_with_cors(status, body)
}

/// `POST /api/poko-market`.
///
/// Order matters and mirrors Node: the service token is checked first (503 when
/// unset), then the bearer (401), then the method (405), then the tool (400).
pub async fn poko_market(
    State(state): State<DomainState>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if crate::domain::poko_bets::service_token().is_empty() {
        return json_with_cors(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "error": "poko-market not configured: POKO_MARKET_SERVICE_TOKEN missing" }),
        );
    }
    if !super::poko::is_service_authorized(super::authorization(&headers)) {
        return json_with_cors(StatusCode::UNAUTHORIZED, json!({ "error": "unauthorized" }));
    }
    if method != Method::POST {
        return json_with_cors(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "POST only" }));
    }
    let body = parse_body(&body);
    let tool = clean_text(&string_field(&body, "tool"), 40);
    if !tool_names().contains(&tool.as_str()) {
        return json_with_cors(
            StatusCode::BAD_REQUEST,
            json!({ "error": format!("unknown tool; expected one of {}", tool_names().join(", ")) }),
        );
    }
    let params = match body.get("params") {
        Some(Json::Object(_)) => body.get("params").cloned().unwrap_or_else(|| json!({})),
        _ => json!({}),
    };
    tracing::debug!(%tool, "poko-market request");

    let db = match state.marketplace_db() {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, "poko-market tool failed");
            return market_failed(&tool);
        }
    };
    let pairs: Vec<(String, String)> = headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    let game = crate::domain::marketplace_game::parse_game_from_request(
        &pairs,
        body.get("game").and_then(Json::as_str),
        None,
    );
    let deps = MarketDeps {
        db,
        tcg: tcg_pool(),
        game,
        now_ms: state.clock().now().timestamp_millis(),
    };
    let today = deps.today();
    match run_tool(&deps, &tool, &params).await {
        Ok(result) => {
            let status = result.get("status").and_then(Json::as_str).unwrap_or("");
            let mut payload = Map::new();
            payload.insert("ok".into(), json!(true));
            payload.insert("tool".into(), json!(tool));
            payload.insert("today".into(), json!(today));
            if let Some(fields) = result.as_object() {
                for (key, value) in fields {
                    payload.insert(key.clone(), value.clone());
                }
            }
            json_with_cors(status_for_tool(status), Json::Object(payload))
        }
        Err(error) => {
            tracing::error!(
                message = %error.message().chars().take(300).collect::<String>(),
                "poko-market tool failed"
            );
            market_failed(&tool)
        }
    }
}

/// `{ ok: false, tool, error: 'market query failed' }`.
fn market_failed(tool: &str) -> Response {
    json_with_cors(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "ok": false, "tool": tool, "error": "market query failed" }),
    )
}

/// The declared tools, for the 400 fallback (mirrors `TOOLS`).
pub fn tool_list() -> &'static [&'static str] {
    &TOOLS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plausible_sold_keeps_the_two_bounds() {
        let sql = plausible_sold("sold.median_pkn", "$7");
        assert!(sql.contains("sold.median_pkn <= asks.ask_pkn * $7"));
        assert!(sql.contains("sold.median_pkn < 100000"));
        assert!(sql.contains("sold.median_pkn <= asks.ask_pkn * 3"));
        assert!(sql.contains("asks.ask_pkn is null and sold.median_pkn < 200000"));
    }

    #[test]
    fn rarity_aliases_normalize() {
        for (input, expected) in [
            ("sir", "Special Illustration Rare"),
            ("SAR", "Special Illustration Rare"),
            ("special art rares", "Special Illustration Rare"),
            ("ir", "Illustration Rare"),
            ("Art Rare", "Illustration Rare"),
            ("ur", "Ultra Rare"),
            ("hr", "Hyper Rare"),
            ("sr", "Secret Rare"),
            ("Secret Rares", "Secret Rare"),
        ] {
            assert_eq!(normalize_rarity(input), expected, "{input}");
        }
        // Anything else passes through, empty stays empty.
        assert_eq!(normalize_rarity("Promo"), "Promo");
        assert_eq!(normalize_rarity(""), "");
    }

    #[test]
    fn set_tokens_drop_the_filler_words() {
        assert_eq!(
            set_tokens("Sales of Neo Discovery"),
            vec!["neo".to_string(), "discovery".to_string()]
        );
        assert_eq!(set_tokens("set expansion espansione"), Vec::<String>::new());
        assert_eq!(set_tokens("151 vendite"), vec!["151".to_string()]);
        assert_eq!(set_tokens(""), Vec::<String>::new());
    }

    #[test]
    fn era_codes_map_to_their_blocks() {
        assert_eq!(era_for_code("base1"), Some("Wizards of the Coast"));
        assert_eq!(era_for_code("neo4"), Some("Wizards of the Coast"));
        assert_eq!(era_for_code("ex3"), Some("EX"));
        assert_eq!(era_for_code("dp1"), Some("Diamond & Pearl"));
        assert_eq!(era_for_code("hgss2"), Some("HeartGold & SoulSilver"));
        assert_eq!(era_for_code("bw6"), Some("Black & White"));
        assert_eq!(era_for_code("xy11"), Some("XY"));
        assert_eq!(era_for_code("sm12"), Some("Sun & Moon"));
        assert_eq!(era_for_code("swsh9"), Some("Sword & Shield"));
        assert_eq!(era_for_code("sv3"), Some("Scarlet & Violet"));
        assert_eq!(era_for_code("me1"), Some("Mega Evolution"));
        assert_eq!(era_for_code("tk-xy"), Some("XY"));
        assert_eq!(era_for_code("tk-bw"), Some("Black & White"));
        assert_eq!(era_for_code("unknown1"), None);
        assert_eq!(era_for_code(""), None);
    }

    #[test]
    fn nationality_follows_the_print_language() {
        assert_eq!(nationality_for_language("JP"), Some("japanese"));
        assert_eq!(nationality_for_language("ZH"), Some("chinese"));
        assert_eq!(nationality_for_language("ZHT"), Some("chinese"));
        assert_eq!(nationality_for_language("KO"), Some("korean"));
        assert_eq!(nationality_for_language("EN"), None);
    }

    #[test]
    fn bounded_matches_the_node_clamps() {
        assert_eq!(bounded(&json!({}), "days", 30.0, 1.0, 90.0), 30.0);
        assert_eq!(bounded(&json!({ "days": 5 }), "days", 30.0, 1.0, 90.0), 5.0);
        assert_eq!(bounded(&json!({ "days": 0 }), "days", 30.0, 1.0, 90.0), 30.0);
        assert_eq!(bounded(&json!({ "days": 500 }), "days", 30.0, 1.0, 90.0), 90.0);
        assert_eq!(bounded(&json!({ "days": -4 }), "days", 30.0, 1.0, 90.0), 1.0);
    }

    #[test]
    fn source_shapers_render_the_history_shape() {
        let rows = vec![json!({
            "day": "2026-10-01", "dump_day": "2026-09-30",
            "lowest_ask_pkn": 120.5, "listing_count": 3, "listed_quantity": 5,
            "seller_count": 2, "refreshed_at": "2026-10-01T06:00:00Z"
        })];
        let source = cardtrader_source(&rows, "");
        assert_eq!(source["source"], json!("cardtrader_listed"));
        assert_eq!(source["status"], json!("available"));
        assert_eq!(source["days"][0]["day"], json!("2026-10-01"));
        assert_eq!(source["days"][0]["dumpDay"], json!("2026-09-30"));
        assert_eq!(source["days"][0]["listingCount"], json!(3));
        assert_eq!(cardtrader_source(&[], "")["status"], json!("empty"));
        assert_eq!(cardtrader_source(&[], "unavailable")["status"], json!("unavailable"));

        let tcg = vec![
            json!({ "category_id": 3, "product_id": 11, "subtype": "normal",
                    "observed_on": "2026-10-01", "market_price": 4.5, "low_price": 3.0,
                    "mid_price": 4.0, "high_price": 6.0, "direct_low_price": 3.5,
                    "snapshot_timestamp": "2026-10-01T00:00:00Z" }),
            json!({ "category_id": 3, "product_id": 11, "subtype": "normal",
                    "observed_on": "2026-10-02", "market_price": 5.0 }),
        ];
        let source = tcgplayer_source(&tcg, "");
        assert_eq!(source["source"], json!("tcgcsv/tcgplayer"));
        assert_eq!(source["currency"], json!("USD"));
        assert_eq!(source["status"], json!("available"));
        let series = source["series"].as_array().unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(series[0]["productId"], json!("11"));
        assert_eq!(series[0]["days"].as_array().unwrap().len(), 2);
        assert_eq!(tcgplayer_source(&[], "")["status"], json!("empty"));
        assert_eq!(tcgplayer_source(&[], "unconfigured")["status"], json!("unconfigured"));
    }
}
