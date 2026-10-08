//! `/api/cardtrader-blueprint-listings` — historical/daily CardTrader listing
//! snapshots. Native port of `cardtrader-blueprint-listings.js`.

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::db::DbPools;
use crate::error::{clean_text, ApiError, ApiResult};

pub const PROVIDER: &str = "cardtrader";
pub const DEFAULT_LIMIT: i64 = 100;
pub const MAX_LIMIT: i64 = 250;
pub const MAX_PAGE: i64 = 1000;

fn sensitive_key(key: &str) -> bool {
    let lowered = key.to_lowercase();
    [
        "token",
        "secret",
        "password",
        "authorization",
        "credential",
        "cookie",
        "api_key",
        "api-key",
        "apikey",
        "private_key",
        "private-key",
        "privatekey",
        "email",
        "phone",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// `sanitizeMetadata` — depth 4, arrays capped at 50, sensitive keys dropped.
pub fn sanitize_metadata(value: &Value, depth: usize) -> Value {
    if depth > 4 {
        return Value::Null;
    }
    match value {
        Value::Null => Value::Null,
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(50)
                .map(|item| sanitize_metadata(item, depth + 1))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, nested) in map {
                let clean_key = clean_text(Some(key), 120);
                if clean_key.is_empty() || sensitive_key(&clean_key) {
                    continue;
                }
                out.insert(clean_key, sanitize_metadata(nested, depth + 1));
            }
            Value::Object(out)
        }
        Value::String(text) => Value::String(clean_text(Some(text), 1000)),
        Value::Number(number) => {
            if number.as_f64().map(|value| value.is_finite()).unwrap_or(false) {
                value.clone()
            } else {
                Value::Null
            }
        }
        Value::Bool(_) => value.clone(),
    }
}

pub fn clean_numeric_id(value: &str) -> String {
    let text = clean_text(Some(value), 80);
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return String::new();
    }
    match text.parse::<u64>() {
        Ok(number) if number > 0 => number.to_string(),
        _ => String::new(),
    }
}

/// Local `cleanCardId` — `[A-Za-z0-9:_-]+`.
pub fn clean_card_id(value: &str) -> String {
    let text = clean_text(Some(value), 80);
    if text.is_empty()
        || !text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
    {
        return String::new();
    }
    text
}

pub fn clean_limit(value: Option<&str>) -> i64 {
    match value {
        None => DEFAULT_LIMIT,
        Some(text) if text.trim().is_empty() => DEFAULT_LIMIT,
        Some(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(|number| (number.trunc() as i64).clamp(1, MAX_LIMIT))
            .unwrap_or(DEFAULT_LIMIT),
    }
}

pub fn clean_page(value: Option<&str>) -> i64 {
    match value {
        None => 1,
        Some(text) if text.trim().is_empty() => 1,
        Some(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(|number| (number.trunc() as i64).clamp(1, MAX_PAGE))
            .unwrap_or(1),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BlueprintListingsRequest {
    pub blueprint_id: String,
    pub card_id: String,
    pub requested_id: String,
    pub requested_param: &'static str,
    pub limit: i64,
    pub page: i64,
    pub cursor: String,
}

/// `parseListingRequest`.
pub fn parse_request(query: &[(String, String)]) -> ApiResult<BlueprintListingsRequest> {
    let first = |names: &[&str]| -> String {
        for name in names {
            if let Some((_, value)) = query.iter().find(|(key, _)| key == name) {
                if !value.trim().is_empty() {
                    return value.clone();
                }
            }
        }
        String::new()
    };
    let blueprint_input = first(&[
        "blueprintId",
        "blueprint_id",
        "cardtraderBlueprintId",
        "cardtrader_blueprint_id",
        "id",
    ]);
    let card_input = first(&["cardId", "card_id"]);
    let blueprint_id = if blueprint_input.is_empty() {
        String::new()
    } else {
        clean_numeric_id(&blueprint_input)
    };
    let card_id = if card_input.is_empty() {
        String::new()
    } else {
        clean_card_id(&card_input)
    };
    if !blueprint_input.is_empty() && blueprint_id.is_empty() {
        return Err(ApiError::bad_request("Missing or invalid blueprintId."));
    }
    if !card_input.is_empty() && card_id.is_empty() {
        return Err(ApiError::bad_request("Missing or invalid cardId."));
    }
    if blueprint_id.is_empty() && card_id.is_empty() {
        return Err(ApiError::bad_request("Provide blueprintId or cardId."));
    }
    let requested_id = if blueprint_id.is_empty() { card_id.clone() } else { blueprint_id.clone() };
    Ok(BlueprintListingsRequest {
        requested_param: if blueprint_id.is_empty() { "cardId" } else { "blueprintId" },
        blueprint_id,
        card_id,
        requested_id,
        limit: clean_limit(Some(&first(&["limit"]))),
        page: clean_page(Some(&first(&["page"]))),
        cursor: clean_text(Some(&first(&["cursor"])), 500),
    })
}

/// `encodeCursor` — base64url of `[lastSeenAt, externalListingId]`.
pub fn encode_cursor(last_seen_at: &str, external_listing_id: &str) -> String {
    let last = clean_text(Some(last_seen_at), 120);
    let listing = clean_text(Some(external_listing_id), 240);
    if last.is_empty() || listing.is_empty() {
        return String::new();
    }
    let payload = serde_json::to_vec(&json!([last, listing])).unwrap_or_default();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cursor {
    pub last_seen_at: String,
    pub external_listing_id: String,
}

/// `decodeCursor`.
pub fn decode_cursor(cursor: &str) -> Option<Cursor> {
    let text = clean_text(Some(cursor), 500);
    if text.is_empty() {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text).ok()?;
    let decoded: Value = serde_json::from_slice(&bytes).ok()?;
    let rows = decoded.as_array()?;
    if rows.len() != 2 {
        return None;
    }
    let last_seen_at = clean_text(rows[0].as_str(), 120);
    let external_listing_id = clean_text(rows[1].as_str(), 240);
    if last_seen_at.is_empty() || external_listing_id.is_empty() {
        return None;
    }
    Some(Cursor { last_seen_at, external_listing_id })
}

fn to_iso_string(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::String(text) => {
            if text.is_empty() {
                Value::Null
            } else {
                Value::String(text.clone())
            }
        }
        other => other.clone(),
    }
}

fn number_or_null(value: &Value) -> Value {
    match value {
        Value::Number(number) => Value::Number(number.clone()),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .map(|number| json!(number))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn integer_or_null(value: &Value) -> Value {
    match value {
        Value::Number(number) => number
            .as_i64()
            .map(|value| json!(value))
            .unwrap_or(Value::Null),
        Value::String(text) => text
            .trim()
            .parse::<i64>()
            .ok()
            .map(|value| json!(value))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// `listingRow`.
pub fn listing_row(row: &Value) -> Value {
    let blueprint_id = row.get("blueprint_id").unwrap_or(&Value::Null);
    let cardtrader_blueprint = row
        .get("cardtrader_blueprint_id")
        .filter(|value| !value.is_null())
        .unwrap_or(blueprint_id);
    json!({
        "externalListingId": string_of(row.get("external_listing_id").unwrap_or(&Value::Null)),
        "externalProductId": string_of(row.get("external_product_id").unwrap_or(&Value::Null)),
        "blueprintId": if blueprint_id.is_null() { Value::Null } else { json!(string_of(blueprint_id)) },
        "cardtraderBlueprintId": if cardtrader_blueprint.is_null() { Value::Null } else { json!(string_of(cardtrader_blueprint)) },
        "pokoinCardId": string_of(row.get("pokoin_card_id").unwrap_or(&Value::Null)),
        "price": number_or_null(row.get("price").unwrap_or(&Value::Null)),
        "priceCents": integer_or_null(row.get("price_cents").unwrap_or(&Value::Null)),
        "currency": string_of(row.get("currency").unwrap_or(&Value::Null)),
        "quantity": row.get("quantity").and_then(Value::as_f64).unwrap_or(0.0),
        "condition": string_of(row.get("condition").unwrap_or(&Value::Null)),
        "language": string_of(row.get("language").unwrap_or(&Value::Null)),
        "properties": sanitize_metadata(row.get("properties").unwrap_or(&json!({})), 0),
        "rawMetadata": sanitize_metadata(row.get("raw_metadata").unwrap_or(&json!({})), 0),
        "seller": {
            "accountId": string_of(row.get("seller_account_id").unwrap_or(&Value::Null)),
            "accountName": string_of(row.get("seller_account_name").unwrap_or(&Value::Null)),
            "country": string_of(row.get("seller_country").unwrap_or(&Value::Null)),
            "type": string_of(row.get("seller_type").unwrap_or(&Value::Null)),
        },
        "firstSeenAt": to_iso_string(row.get("first_seen_at").unwrap_or(&Value::Null)),
        "lastSeenAt": to_iso_string(row.get("last_seen_at").unwrap_or(&Value::Null)),
        "importedAt": to_iso_string(row.get("imported_at").unwrap_or(&Value::Null)),
        "updatedAt": to_iso_string(row.get("updated_at").unwrap_or(&Value::Null)),
        "source": { "provider": string_of(row.get("provider").unwrap_or(&json!(PROVIDER))),
                    "table": "cardtrader_market_listing_snapshots" },
    })
}

/// `readCardTraderBlueprintListings` — snapshot page + cursor/next-page paging.
pub async fn read_blueprint_listings(db: &DbPools, request: &BlueprintListingsRequest) -> ApiResult<Value> {
    let mut values: Vec<Value> = Vec::new();
    let mut filters: Vec<String> = vec!["provider = $1".into(), "quantity > 0".into()];
    values.push(json!(PROVIDER));

    let mut match_conditions: Vec<String> = Vec::new();
    if !request.blueprint_id.is_empty() {
        values.push(json!(request.blueprint_id.parse::<i64>().unwrap_or(0)));
        let index = values.len();
        match_conditions.push(format!("blueprint_id = ${index}::bigint"));
        match_conditions.push(format!("cardtrader_blueprint_id = ${index}::bigint"));
    }
    if !request.card_id.is_empty() {
        values.push(json!(request.card_id));
        let index = values.len();
        match_conditions.push(format!("pokoin_card_id = ${index}::text"));
        let numeric = clean_numeric_id(&request.card_id);
        if !numeric.is_empty() {
            values.push(json!(numeric.parse::<i64>().unwrap_or(0)));
            let numeric_index = values.len();
            match_conditions.push(format!("blueprint_id = ${numeric_index}::bigint"));
            match_conditions.push(format!("cardtrader_blueprint_id = ${numeric_index}::bigint"));
        }
    }
    filters.push(format!("({})", match_conditions.join(" or ")));

    let cursor = decode_cursor(&request.cursor);
    if !request.cursor.is_empty() && cursor.is_none() {
        return Err(ApiError::bad_request("Invalid cursor."));
    }
    if let Some(cursor) = &cursor {
        values.push(json!(cursor.last_seen_at));
        let last_seen_index = values.len();
        values.push(json!(cursor.external_listing_id));
        let listing_index = values.len();
        filters.push(format!(
            "(last_seen_at < ${last_seen_index}::text::timestamptz or (last_seen_at = ${last_seen_index}::text::timestamptz and external_listing_id > ${listing_index}::text))"
        ));
    }

    let limit = request.limit;
    let page = request.page;
    let offset = if cursor.is_some() { 0 } else { (page - 1) * limit };
    values.push(json!(limit + 1));
    let limit_index = values.len();
    values.push(json!(offset));
    let offset_index = values.len();

    let sql = format!(
        "
      select
        provider, external_listing_id, external_product_id, blueprint_id, cardtrader_blueprint_id,
        pokoin_card_id, seller_account_id, seller_account_name, seller_country, seller_type,
        quantity, condition, language, price, price_cents, currency, properties, raw_metadata,
        first_seen_at, last_seen_at, imported_at, updated_at
      from public.cardtrader_market_listing_snapshots
      where {}
      order by last_seen_at desc, external_listing_id asc
      limit ${limit_index}
      offset ${offset_index}
",
        filters.join("\n        and ")
    );

    let rows = db.query("pokemon", &sql, &values).await?;
    let page_rows: Vec<&Value> = rows.iter().take(limit.max(0) as usize).collect();
    let last_row = page_rows.last().copied();
    let has_more = rows.len() as i64 > limit;

    let cardtrader_blueprint_ids: Vec<String> = {
        let mut ids: Vec<String> = Vec::new();
        for row in &page_rows {
            let value = row
                .get("cardtrader_blueprint_id")
                .filter(|value| !value.is_null())
                .or_else(|| row.get("blueprint_id"))
                .filter(|value| !value.is_null());
            if let Some(value) = value {
                let text = string_of(value);
                if !text.is_empty() && !ids.contains(&text) {
                    ids.push(text);
                }
            }
        }
        ids
    };
    let pokoin_card_ids: Vec<String> = {
        let mut ids: Vec<String> = Vec::new();
        for row in &page_rows {
            let text = string_of(row.get("pokoin_card_id").unwrap_or(&Value::Null));
            if !text.is_empty() && !ids.contains(&text) {
                ids.push(text);
            }
        }
        ids
    };

    let next_cursor = if has_more {
        last_row
            .map(|row| {
                encode_cursor(
                    &string_of(row.get("last_seen_at").unwrap_or(&Value::Null)),
                    &string_of(row.get("external_listing_id").unwrap_or(&Value::Null)),
                )
            })
            .filter(|cursor| !cursor.is_empty())
    } else {
        None
    };

    Ok(json!({
        "ok": true,
        "provider": PROVIDER,
        "source": "oracle_cardtrader_market_listing_snapshots",
        "liveCardTraderApiUsed": false,
        "requested": {
            "id": request.requested_id,
            "param": request.requested_param,
            "blueprintId": if request.blueprint_id.is_empty() { Value::Null } else { json!(request.blueprint_id) },
            "cardId": if request.card_id.is_empty() { Value::Null } else { json!(request.card_id) },
        },
        "mapping": { "cardtraderBlueprintIds": cardtrader_blueprint_ids, "pokoinCardIds": pokoin_card_ids, "supportsPokoinCardId": true },
        "pagination": {
            "limit": limit,
            "page": if cursor.is_some() { Value::Null } else { json!(page) },
            "cursor": if request.cursor.is_empty() { Value::Null } else { json!(request.cursor) },
            "nextCursor": next_cursor,
            "nextPage": if has_more && cursor.is_none() { json!(page + 1) } else { Value::Null },
            "hasMore": has_more,
        },
        "count": page_rows.len(),
        "listings": page_rows.iter().map(|row| listing_row(row)).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn request_parsing_matches_reference() {
        let request = parse_request(&query(&[("blueprintId", "123"), ("limit", "999"), ("page", "5000")])).unwrap();
        assert_eq!(request.blueprint_id, "123");
        assert_eq!(request.limit, MAX_LIMIT);
        assert_eq!(request.page, MAX_PAGE);
        assert_eq!(request.requested_param, "blueprintId");
        assert!(parse_request(&query(&[("blueprintId", "abc")])).is_err());
        assert!(parse_request(&query(&[])).is_err());
        let card = parse_request(&query(&[("cardId", "oura-12_3")])).unwrap();
        assert_eq!(card.card_id, "oura-12_3");
        assert_eq!(card.requested_param, "cardId");
    }

    #[test]
    fn cursor_round_trips_and_rejects_junk() {
        let cursor = encode_cursor("2026-10-08T00:00:00.000Z", "abc-1");
        let decoded = decode_cursor(&cursor).unwrap();
        assert_eq!(decoded.last_seen_at, "2026-10-08T00:00:00.000Z");
        assert_eq!(decoded.external_listing_id, "abc-1");
        assert!(decode_cursor("not-base64!!").is_none());
        assert!(decode_cursor("").is_none());
        assert_eq!(encode_cursor("", "x"), "");
    }

    #[test]
    fn metadata_is_sanitized() {
        let value = json!({
            "condition": "Near Mint",
            "api_key": "secret",
            "nested": {"email": "a@b.c", "ok": 1},
            "arr": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
        });
        let clean = sanitize_metadata(&value, 0);
        assert_eq!(clean["condition"], "Near Mint");
        assert!(clean.get("api_key").is_none());
        assert!(clean["nested"].get("email").is_none());
        assert_eq!(clean["nested"]["ok"], 1);
        assert!(clean["arr"].as_array().unwrap().len() <= 50);
    }

    #[test]
    fn listing_row_shapes_ids_and_seller() {
        let row = json!({
            "external_listing_id": "L1", "external_product_id": "P1", "blueprint_id": 12,
            "pokoin_card_id": "24", "quantity": 2, "price": 1.5, "price_cents": 150,
            "currency": "EUR", "seller_account_id": "7", "seller_account_name": "pknreserve",
            "last_seen_at": "2026-10-08T00:00:00.000Z"
        });
        let out = listing_row(&row);
        assert_eq!(out["externalListingId"], "L1");
        assert_eq!(out["blueprintId"], "12");
        assert_eq!(out["cardtraderBlueprintId"], "12");
        assert_eq!(out["seller"]["accountId"], "7");
        assert_eq!(out["source"]["table"], "cardtrader_market_listing_snapshots");
    }
}
