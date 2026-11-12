//! BuySell buy orders, version 1: a standing, non-binding offer to buy a card.
//! Nothing here moves money. "Sell now" creates an ordinary listing at the
//! offer price through the listing creation path and records a fill row; the
//! buyer buys that listing through the existing cart and checkout.
//!
//! What is left of an order and whether it is live are derived on every read
//! from `marketplace_buy_order_fills` joined to the fill's listing (see
//! [`derived`] and `domain::buy_orders::derive_state`). Migration:
//! `scripts/sql/142_marketplace_buy_orders.sql`.
use super::cart::limit_best_effort;
use super::listings::{self, Prepared};
use super::{created_json, private_json};
use crate::domain::buy_orders as rules;
use crate::domain::notify;
use crate::error::ApiError;
use crate::listing_live as live;
use crate::state::{AuthedUser, DomainState};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use pokoin_api_common::http;
use serde_json::{json, Map, Value};
use sqlx::PgExecutor;

const BOARD_LIMIT_DEFAULT: i64 = 30;
const BOARD_LIMIT_MAX: i64 = 60;
const LIST_CAP: i64 = 200;
const WRITES_PER_MINUTE: i64 = 30;

fn bad(code: &str) -> ApiError {
    ApiError::bad_request(code).with_code(code)
}

fn conflict(code: &str) -> ApiError {
    ApiError::conflict(code).with_code(code)
}

fn not_found() -> ApiError {
    ApiError::not_found("not_found").with_code("not_found")
}

/// `{error, code}`; a conflict that names an existing order also carries `id`.
fn error_response(error: ApiError) -> Response {
    let mut body = error.body();
    if let Some(id) = error.meta.as_ref().and_then(|meta| meta.get("id")).cloned() {
        body["id"] = id;
    }
    (error.status, Json(body)).into_response()
}

fn public_book_json(body: Value) -> Response {
    let mut response = (StatusCode::OK, Json(body)).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=15"),
    );
    response
}

fn parse_id(raw: &str) -> Result<uuid::Uuid, ApiError> {
    uuid::Uuid::parse_str(raw).map_err(|_| not_found())
}

async fn throttle(state: &DomainState, scope: &str, uid: &str) -> Result<(), ApiError> {
    let (allowed, _) = limit_best_effort(state, scope, uid, WRITES_PER_MINUTE, 60).await;
    if allowed {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "rate_limited").with_code("rate_limited"))
    }
}

// ------------------------------------------------------------ the one live rule

/// Every read goes through this CTE: the order row plus `counted` (units in
/// fills whose listing is `active` or `sold_out`), `remaining` and `state`.
/// A fill whose listing was paused, deactivated or deleted does not count.
fn derived(filter: &str) -> String {
    format!(
        "with orders as (select o.*, c.counted, greatest(o.quantity - c.counted, 0)::int as remaining, \
           case when o.status <> 'open' then 'cancelled' \
                when o.quantity - c.counted <= 0 then 'filled' \
                when o.expires_at is not null and o.expires_at <= now() then 'expired' \
                else 'open' end as state, \
           o.price_pkn::text as price_text, \
           to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as created_cursor \
         from public.marketplace_buy_orders o \
         cross join lateral (select coalesce(sum(f.quantity), 0)::int as counted \
           from public.marketplace_buy_order_fills f \
           join public.marketplace_user_listings l on l.id = f.listing_id \
           where f.buy_order_id = o.id and l.status in ('active', 'sold_out')) c \
         where {filter}) "
    )
}

async fn fetch_order<'e>(
    executor: impl PgExecutor<'e>,
    id: uuid::Uuid,
) -> Result<Option<Value>, ApiError> {
    let sql = format!(
        "{}select to_jsonb(orders) from orders",
        derived("o.id = $1")
    );
    Ok(sqlx::query_scalar(&sql)
        .bind(id)
        .fetch_optional(executor)
        .await?)
}

fn state_of(order: &Value) -> rules::State {
    let at = order["expires_at"]
        .as_str()
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|d| d.with_timezone(&Utc));
    // The SQL already derived it with the database clock; the pure rule is
    // the same function and agrees on every row the SQL returns.
    match order["state"].as_str() {
        Some("filled") => rules::State::Filled,
        Some("expired") => rules::State::Expired,
        Some("cancelled") => rules::State::Cancelled,
        Some(_) => rules::State::Open,
        None => rules::derive_state(
            order["status"].as_str().unwrap_or("cancelled"),
            live::number(&order["quantity"]) as i64,
            live::number(&order["counted"]) as i64,
            at,
            Utc::now(),
        ),
    }
}

// ------------------------------------------------------------ JSON shapes

/// Fields every list shows.
pub fn item_json(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "card_id": row["card_id"],
        "card_name": row["card_name"],
        "card_image_url": row["card_image_url"],
        "set_name": row["set_name"],
        "collector_number": row["collector_number"],
        "condition": row["condition"],
        "language": row["language"],
        "reverse": row["reverse"],
        "first_edition": row["first_edition"],
        "price_pkn": row["price_pkn"],
        "remaining": row["remaining"],
        "expires_at": row["expires_at"],
        "created_at": row["created_at"],
        "buyer_name": row["buyer_name"],
    })
}

/// The buyer's own view: the item plus quantity, state and fills. With
/// `only_seller` only that seller's fills are listed, so a sell response never
/// shows another seller's private note. Each fill carries the note the seller
/// wrote to this buyer.
pub fn mine_json(row: &Value, fills: &[Value], only_seller: Option<&str>) -> Value {
    let mut out = item_json(row);
    out["quantity"] = row["quantity"].clone();
    out["state"] = row["state"].clone();
    let listed: Vec<Value> = fills
        .iter()
        .filter(|fill| only_seller.is_none_or(|uid| fill["seller_uid"] == uid))
        .map(|fill| {
            json!({
                "listing_id": fill["listing_id"],
                "quantity": fill["quantity"],
                "price_pkn": fill["price_pkn"],
                "created_at": fill["created_at"],
                "listing_status": fill["listing_status"],
                // The seller's private note to this buyer; never anyone else's.
                "seller_message": fill["seller_message"].as_str().unwrap_or_default(),
            })
        })
        .collect();
    out["fills"] = Value::Array(listed);
    out
}

const FILLS_SQL: &str = "select to_jsonb(v) from (select f.buy_order_id::text as buy_order_id, f.listing_id::text as listing_id, \
       f.seller_uid, f.quantity, f.price_pkn, f.created_at, f.seller_message, coalesce(l.status, 'deleted') as listing_status \
     from public.marketplace_buy_order_fills f \
     left join public.marketplace_user_listings l on l.id = f.listing_id \
     where f.buy_order_id = any($1) order by f.created_at, f.id) v";

async fn fills_for<'e>(
    executor: impl PgExecutor<'e>,
    ids: &[uuid::Uuid],
) -> Result<Vec<Value>, ApiError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_scalar(FILLS_SQL)
        .bind(ids.to_vec())
        .fetch_all(executor)
        .await?)
}

fn fills_of(fills: &[Value], order: &Value) -> Vec<Value> {
    fills
        .iter()
        .filter(|fill| fill["buy_order_id"] == order["id"])
        .cloned()
        .collect()
}

// ------------------------------------------------------------ parsing

/// A validated `POST /api/marketplace-buy-orders` body.
#[derive(Clone, Debug, PartialEq)]
pub struct NewOrder {
    pub card_id: String,
    pub condition: &'static str,
    pub language: String,
    pub reverse: bool,
    pub first_edition: bool,
    pub price_pkn: f64,
    pub quantity: i64,
    pub days: Option<i64>,
    pub buyer_name: String,
    pub card_name: String,
    pub card_image_url: String,
    pub set_name: String,
    pub collector_number: String,
}

pub fn parse_new_order(body: &Value) -> Result<NewOrder, ApiError> {
    if !body.is_object() {
        return Err(bad("invalid_body"));
    }
    let card_id = live::field(body, "card_id", 80);
    if card_id.is_empty() {
        return Err(bad("invalid_card"));
    }
    let condition = rules::parse_condition(&live::field(body, "condition", 20)).map_err(bad)?;
    let language = rules::parse_language(&live::field(body, "language", 10)).map_err(bad)?;
    let price_pkn = rules::parse_price(&body["price_pkn"]).map_err(bad)?;
    let quantity = rules::parse_quantity(&body["quantity"]).map_err(bad)?;
    let days =
        rules::parse_days(body.get("days").ok_or_else(|| bad("invalid_days"))?).map_err(bad)?;
    Ok(NewOrder {
        card_id,
        condition,
        language,
        reverse: body["reverse"] == true,
        first_edition: body["first_edition"] == true,
        price_pkn,
        quantity,
        days,
        buyer_name: live::field(body, "buyer_name", 120),
        card_name: live::field(body, "card_name", 240),
        card_image_url: live::field(body, "card_image_url", 800),
        set_name: live::field(body, "set_name", 240),
        collector_number: live::field(body, "collector_number", 80),
    })
}

/// A validated `PATCH` body: only the keys that were sent.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderPatch {
    pub price_pkn: Option<f64>,
    pub quantity: Option<i64>,
    /// `Some(None)` is "until cancelled".
    pub days: Option<Option<i64>>,
}

pub fn parse_patch(body: &Value) -> Result<OrderPatch, ApiError> {
    if !body.is_object() {
        return Err(bad("invalid_body"));
    }
    let patch = OrderPatch {
        price_pkn: body
            .get("price_pkn")
            .map(rules::parse_price)
            .transpose()
            .map_err(bad)?,
        quantity: body
            .get("quantity")
            .map(rules::parse_quantity)
            .transpose()
            .map_err(bad)?,
        days: body
            .get("days")
            .map(rules::parse_days)
            .transpose()
            .map_err(bad)?,
    };
    if patch
        == (OrderPatch {
            price_pkn: None,
            quantity: None,
            days: None,
        })
    {
        return Err(bad("nothing_to_update"));
    }
    Ok(patch)
}

/// The listing body "Sell now" sends through the normal listing path: the
/// order's card, facets, price and display fields, plus only the seller
/// fields that are not fixed by the order.
pub fn listing_body(order: &Value, quantity: i64, seller: &Value) -> Value {
    let mut body = Map::new();
    for key in [
        "sellerName",
        "sellerCountry",
        "shipFromCountry",
        "shippingAvailable",
        "sellerComment",
        "location",
    ] {
        if let Some(value) = seller.get(key) {
            body.insert(key.into(), value.clone());
        }
    }
    let pairs = [
        ("cardId", "card_id"),
        ("condition", "condition"),
        ("language", "language"),
        ("reverse", "reverse"),
        ("firstEdition", "first_edition"),
        ("pricePkn", "price_pkn"),
        ("cardName", "card_name"),
        ("cardImageUrl", "card_image_url"),
        ("setName", "set_name"),
        ("collectorNumber", "collector_number"),
        ("marketplaceGame", "marketplace_game"),
    ];
    for (to, from) in pairs {
        body.insert(to.into(), order[from].clone());
    }
    body.insert("quantityAvailable".into(), json!(quantity));
    body.insert("source".into(), json!("buy_order"));
    body.insert("sourceListingId".into(), order["id"].clone());
    body.insert("status".into(), json!("active"));
    Value::Object(body)
}

/// `before` cursor of the board: `created|id` (recent) or `price|created|id`.
#[derive(Clone, Debug, PartialEq)]
pub enum Cursor {
    Recent {
        created: String,
        id: uuid::Uuid,
    },
    Price {
        price: String,
        created: String,
        id: uuid::Uuid,
    },
}

pub fn parse_cursor(raw: &str, by_price: bool) -> Result<Cursor, ApiError> {
    let invalid = || bad("invalid_cursor");
    let parts: Vec<&str> = raw.split('|').collect();
    let timestamp = |text: &str| {
        DateTime::parse_from_rfc3339(text)
            .map(|_| text.to_string())
            .map_err(|_| invalid())
    };
    match (by_price, parts.as_slice()) {
        (false, [created, id]) => Ok(Cursor::Recent {
            created: timestamp(created)?,
            id: uuid::Uuid::parse_str(id).map_err(|_| invalid())?,
        }),
        (true, [price, created, id]) => {
            let finite = price.parse::<f64>().is_ok_and(f64::is_finite);
            if !finite {
                return Err(invalid());
            }
            Ok(Cursor::Price {
                price: price.to_string(),
                created: timestamp(created)?,
                id: uuid::Uuid::parse_str(id).map_err(|_| invalid())?,
            })
        }
        _ => Err(invalid()),
    }
}

fn next_cursor(row: &Value, by_price: bool) -> String {
    let created = row["created_cursor"].as_str().unwrap_or_default();
    let id = row["id"].as_str().unwrap_or_default();
    if by_price {
        format!(
            "{}|{created}|{id}",
            row["price_text"].as_str().unwrap_or_default()
        )
    } else {
        format!("{created}|{id}")
    }
}

// ------------------------------------------------------------ public reads

/// `GET /api/marketplace-buy-orders?card_id=` — the book for one card: one
/// row per condition/language/finish with live orders. `best_remaining` is the
/// copies left on the `best_order_id` order alone. Never names a buyer.
pub async fn book(State(state): State<DomainState>, headers: HeaderMap, uri: Uri) -> Response {
    let result: Result<Value, ApiError> = async {
        let card_id = http::Query::from_uri(&uri).first("card_id").map(|raw| live::text(&json!(raw), 80)).unwrap_or_default();
        if card_id.is_empty() {
            return Err(bad("invalid_card"));
        }
        let game = listings::request_game(&headers, &uri);
        let sql = format!(
            "{}select to_jsonb(v) from (select condition, language, reverse, first_edition, \
               max(price_pkn) as best_price_pkn, (array_agg(id order by price_pkn desc, created_at asc, id))[1] as best_order_id,                (array_agg(remaining order by price_pkn desc, created_at asc, id))[1] as best_remaining, sum(remaining)::int as quantity, count(*)::int as orders \
             from orders where state = 'open' group by condition, language, reverse, first_edition \
             order by max(price_pkn) desc, condition, language, reverse, first_edition) v",
            derived("o.marketplace_game = $1 and o.card_id = $2 and o.status = 'open'")
        );
        let rows: Vec<Value> = sqlx::query_scalar(&sql).bind(&game).bind(&card_id).fetch_all(state.read_db()).await?;
        Ok(json!({ "card_id": card_id, "book": rows }))
    }
    .await;
    match result {
        Ok(value) => public_book_json(value),
        Err(error) => error_response(error),
    }
}

/// `GET /api/marketplace-buy-orders/board` — live orders across cards.
pub async fn board(State(state): State<DomainState>, headers: HeaderMap, uri: Uri) -> Response {
    let result: Result<Value, ApiError> = async {
        let query = http::Query::from_uri(&uri);
        let limit = query
            .first("limit")
            .filter(|raw| !raw.is_empty())
            .and_then(|raw| raw.parse::<i64>().ok())
            .map(|n| n.clamp(1, BOARD_LIMIT_MAX))
            .unwrap_or(BOARD_LIMIT_DEFAULT);
        let by_price = match query.first("sort").filter(|raw| !raw.is_empty()) {
            None | Some("recent") => false,
            Some("price") => true,
            Some(_) => return Err(bad("invalid_sort")),
        };
        let cursor = match query.first("before").filter(|raw| !raw.is_empty()) {
            Some(raw) => Some(parse_cursor(raw, by_price)?),
            None => None,
        };
        let game = listings::request_game(&headers, &uri);
        let after = match (&cursor, by_price) {
            (None, _) => "",
            (Some(_), false) => " and (created_at, id) < ($3::timestamptz, $4::uuid)",
            (Some(_), true) => " and (price_pkn, created_at, id) < ($3::numeric, $4::timestamptz, $5::uuid)",
        };
        let order = if by_price { "price_pkn desc, created_at desc, id desc" } else { "created_at desc, id desc" };
        let sql = format!(
            "{}select to_jsonb(orders) from orders where state = 'open'{after} order by {order} limit $2",
            derived("o.marketplace_game = $1 and o.status = 'open' and (o.expires_at is null or o.expires_at > now())")
        );
        let mut query = sqlx::query_scalar(&sql).bind(&game).bind(limit + 1);
        query = match cursor {
            None => query,
            Some(Cursor::Recent { created, id }) => query.bind(created).bind(id),
            Some(Cursor::Price { price, created, id }) => query.bind(price).bind(created).bind(id),
        };
        let rows: Vec<Value> = query.fetch_all(state.read_db()).await?;
        let more = rows.len() as i64 > limit;
        let page: Vec<&Value> = rows.iter().take(limit as usize).collect();
        let next = if more { page.last().map(|row| next_cursor(row, by_price)) } else { None };
        Ok(json!({ "items": page.iter().map(|row| item_json(row)).collect::<Vec<_>>(), "next": next }))
    }
    .await;
    match result {
        Ok(value) => public_book_json(value),
        Err(error) => error_response(error),
    }
}

// ------------------------------------------------------------ owner reads

/// `GET /api/marketplace-buy-orders/mine` — the caller's orders, any state.
pub async fn mine(State(state): State<DomainState>, AuthedUser(claims): AuthedUser) -> Response {
    let result: Result<Value, ApiError> = async {
        let sql = format!(
            "{}select to_jsonb(orders) from orders order by created_at desc, id desc limit {LIST_CAP}",
            derived("o.buyer_uid = $1")
        );
        let rows: Vec<Value> = sqlx::query_scalar(&sql).bind(&claims.uid).fetch_all(state.read_db()).await?;
        let ids: Vec<uuid::Uuid> = rows.iter().filter_map(|row| row["id"].as_str().and_then(|id| uuid::Uuid::parse_str(id).ok())).collect();
        let fills = fills_for(state.read_db(), &ids).await?;
        let items: Vec<Value> = rows.iter().map(|row| mine_json(row, &fills_of(&fills, row), None)).collect();
        Ok(json!({ "items": items }))
    }
    .await;
    match result {
        Ok(value) => private_json(value),
        Err(error) => error_response(error),
    }
}

/// `GET /api/marketplace-buy-orders/for-my-listings` — live orders by other
/// buyers that match one of the caller's active listings exactly.
pub async fn for_my_listings(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
) -> Response {
    let result: Result<Value, ApiError> = async {
        let sql = format!(
            "{}select to_jsonb(v) from (select orders.*, m.id::text as my_listing_id, m.price_pkn as my_price_pkn \
             from orders \
             join lateral (select l.id, l.price_pkn from public.marketplace_user_listings l \
               where l.seller_uid = $1 and l.status = 'active' and l.quantity_available > 0 \
                 and l.marketplace_game = orders.marketplace_game and l.card_id = orders.card_id \
                 and l.condition = orders.condition and upper(l.language) = orders.language \
                 and l.reverse = orders.reverse and l.first_edition = orders.first_edition \
               order by l.price_pkn, l.id limit 1) m on true \
             where orders.state = 'open' \
             order by orders.price_pkn desc, orders.created_at desc, orders.id desc limit {LIST_CAP}) v",
            derived("o.status = 'open' and o.buyer_uid <> $1 and (o.expires_at is null or o.expires_at > now())")
        );
        let rows: Vec<Value> = sqlx::query_scalar(&sql).bind(&claims.uid).fetch_all(state.read_db()).await?;
        let items: Vec<Value> = rows
            .iter()
            .map(|row| {
                let mut item = item_json(row);
                item["my_listing_id"] = row["my_listing_id"].clone();
                item["my_price_pkn"] = row["my_price_pkn"].clone();
                item
            })
            .collect();
        Ok(json!({ "items": items }))
    }
    .await;
    match result {
        Ok(value) => private_json(value),
        Err(error) => error_response(error),
    }
}

// ------------------------------------------------------------ owner writes

const INSERT_SQL: &str = "insert into public.marketplace_buy_orders \
     (buyer_uid, buyer_name, marketplace_game, card_id, condition, language, reverse, first_edition, price_pkn, quantity, \
      expires_at, card_name, card_image_url, set_name, collector_number) \
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::float8, $10, $11, $12, $13, $14, $15) returning id";

/// `POST /api/marketplace-buy-orders`
pub async fn create(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let result: Result<Value, ApiError> = async {
        let payload: Value = serde_json::from_slice(&body).map_err(|_| bad("invalid_body"))?;
        let order = parse_new_order(&payload)?;
        throttle(&state, "buy-order-write", &claims.uid).await?;
        let game = listings::request_game(&headers, &uri);
        let expires_at = rules::expiry(DateTime::from_timestamp_millis(state.now_ms()).unwrap_or_else(Utc::now), order.days);

        let mut tx = state.write_db().begin().await?;
        // One buyer's creates run one at a time, so the cap and the duplicate
        // check cannot both pass for two requests at once.
        sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 142))").bind(&claims.uid).execute(&mut *tx).await?;
        let open_filter = "o.buyer_uid = $1 and o.status = 'open'";
        let count_sql = format!("{}select count(*) from orders where state = 'open'", derived(open_filter));
        let open: i64 = sqlx::query_scalar(&count_sql).bind(&claims.uid).fetch_one(&mut *tx).await?;
        if open >= rules::MAX_OPEN_ORDERS {
            return Err(conflict("too_many_buy_orders"));
        }
        let duplicate_sql = format!(
            "{}select id::text from orders where state = 'open' and marketplace_game = $2 and card_id = $3 \
               and condition = $4 and language = $5 and reverse = $6 and first_edition = $7 limit 1",
            derived(open_filter)
        );
        let duplicate: Option<String> = sqlx::query_scalar(&duplicate_sql)
            .bind(&claims.uid)
            .bind(&game)
            .bind(&order.card_id)
            .bind(order.condition)
            .bind(&order.language)
            .bind(order.reverse)
            .bind(order.first_edition)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some(id) = duplicate {
            return Err(conflict("duplicate_buy_order").with_meta(json!({ "id": id })));
        }
        let id: uuid::Uuid = sqlx::query_scalar(INSERT_SQL)
            .bind(&claims.uid)
            .bind(&order.buyer_name)
            .bind(&game)
            .bind(&order.card_id)
            .bind(order.condition)
            .bind(&order.language)
            .bind(order.reverse)
            .bind(order.first_edition)
            .bind(order.price_pkn)
            .bind(order.quantity as i32)
            .bind(expires_at)
            .bind(&order.card_name)
            .bind(&order.card_image_url)
            .bind(&order.set_name)
            .bind(&order.collector_number)
            .fetch_one(&mut *tx)
            .await?;
        let row = fetch_order(&mut *tx, id).await?.ok_or_else(|| ApiError::internal("Pokoin did not confirm the buy order."))?;
        tx.commit().await?;
        Ok(mine_json(&row, &[], None))
    }
    .await;
    match result {
        Ok(value) => created_json(value),
        Err(error) => error_response(error),
    }
}

/// The caller's order, locked for the rest of the transaction; 404 for
/// anyone else's.
async fn lock_own(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: uuid::Uuid,
    uid: &str,
) -> Result<(), ApiError> {
    let owner: Option<String> = sqlx::query_scalar(
        "select buyer_uid from public.marketplace_buy_orders where id = $1 for update",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    match owner {
        Some(owner) if owner == uid => Ok(()),
        _ => Err(not_found()),
    }
}

async fn own_view(state: &DomainState, id: uuid::Uuid) -> Result<Value, ApiError> {
    let row = fetch_order(state.write_db(), id)
        .await?
        .ok_or_else(not_found)?;
    let fills = fills_for(state.write_db(), &[id]).await?;
    Ok(mine_json(&row, &fills, None))
}

/// `PATCH /api/marketplace-buy-orders/{id}` — price, quantity, days.
pub async fn patch(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let result: Result<Value, ApiError> = async {
        let id = parse_id(&id)?;
        let payload: Value = serde_json::from_slice(&body).map_err(|_| bad("invalid_body"))?;
        let patch = parse_patch(&payload)?;
        throttle(&state, "buy-order-write", &claims.uid).await?;
        let mut tx = state.write_db().begin().await?;
        lock_own(&mut tx, id, &claims.uid).await?;
        let row = fetch_order(&mut *tx, id).await?.ok_or_else(not_found)?;
        if !matches!(state_of(&row), rules::State::Open | rules::State::Expired) {
            return Err(conflict("not_editable"));
        }
        if patch.quantity.is_some_and(|quantity| quantity < live::number(&row["counted"]) as i64) {
            return Err(conflict("quantity_below_filled"));
        }
        let touch_days = patch.days.is_some();
        let expires_at = rules::expiry(DateTime::from_timestamp_millis(state.now_ms()).unwrap_or_else(Utc::now), patch.days.flatten());
        sqlx::query(
            "update public.marketplace_buy_orders set price_pkn = coalesce($2::float8, price_pkn), \
               quantity = coalesce($3, quantity), expires_at = case when $4 then $5 else expires_at end, updated_at = now() \
             where id = $1",
        )
        .bind(id)
        .bind(patch.price_pkn)
        .bind(patch.quantity.map(|quantity| quantity as i32))
        .bind(touch_days)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        own_view(&state, id).await
    }
    .await;
    match result {
        Ok(value) => private_json(value),
        Err(error) => error_response(error),
    }
}

/// `DELETE /api/marketplace-buy-orders/{id}` — cancel; idempotent.
pub async fn cancel(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Value, ApiError> = async {
        let id = parse_id(&id)?;
        let cancelled: Option<uuid::Uuid> = sqlx::query_scalar(
            "update public.marketplace_buy_orders set status = 'cancelled', \
               updated_at = case when status = 'cancelled' then updated_at else now() end \
             where id = $1 and buyer_uid = $2 returning id",
        )
        .bind(id)
        .bind(&claims.uid)
        .fetch_optional(state.write_db())
        .await?;
        own_view(&state, cancelled.ok_or_else(not_found)?).await
    }
    .await;
    match result {
        Ok(value) => private_json(value),
        Err(error) => error_response(error),
    }
}

// ------------------------------------------------------------ Sell now

fn sell_error((status, code): (u16, &'static str)) -> ApiError {
    ApiError::new(
        StatusCode::from_u16(status).unwrap_or(StatusCode::CONFLICT),
        code,
    )
    .with_code(code)
}

fn check_order(order: &Value, seller: &str, quantity: i64) -> Result<(), ApiError> {
    rules::check_sellable(
        state_of(order),
        order["buyer_uid"].as_str().unwrap_or_default(),
        seller,
        live::number(&order["remaining"]) as i64,
        quantity,
    )
    .map_err(sell_error)
}

/// Email the buyer that a seller listed at their price, with the seller's
/// private note when there is one. Best effort.
async fn email_buyer(
    state: &DomainState,
    order: &Value,
    quantity: i64,
    seller_note: &str,
) -> Result<(), String> {
    let firestore = state.firestore().map_err(|error| error.message)?;
    let buyer_uid = live::field(order, "buyer_uid", 160);
    let profile = crate::store::read_user(firestore, &buyer_uid)
        .await
        .map_err(|error| error.to_string())?;
    let email = profile
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !crate::email::can_email_user(&email) {
        return Ok(());
    }
    let message = notify::build_buy_order_fill_email(
        &live::field(order, "buyer_name", 120),
        &live::field(order, "card_name", 240),
        &live::field(order, "card_id", 80),
        live::number(&order["price_pkn"]),
        quantity,
        seller_note,
        notify::SELLER_NOTE_LABEL,
    );
    crate::email::send_email(
        state.http(),
        crate::email::MARKETPLACE_FROM,
        &email,
        &message.subject,
        &message.text,
        &message.html,
    )
    .await
    .map(|_| ())
    .map_err(|error| error.message)
}

/// `POST /api/marketplace-buy-orders/{id}/sell` — list into an open order at
/// its price. One transaction: lock the order, recount, create the listing
/// through the listing path, record the fill with the seller's optional note
/// to the buyer. The note is nothing but data: not in the listing body, not in
/// any public read, only on the fill and in the buyer's email.
pub async fn sell(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let result: Result<Value, ApiError> = async {
        let id = parse_id(&id)?;
        let payload: Value = if body.is_empty() { json!({}) } else { serde_json::from_slice(&body).map_err(|_| bad("invalid_body"))? };
        if !payload.is_object() {
            return Err(bad("invalid_body"));
        }
        let quantity = match payload.get("quantity") {
            None | Some(Value::Null) => 1,
            Some(value) => rules::parse_quantity(value).map_err(bad)?,
        };
        let seller_note =
            rules::parse_buyer_message(&payload["buyer_message"]).map_err(bad)?;
        throttle(&state, "buy-order-sell", &claims.uid).await?;

        let first = fetch_order(state.write_db(), id).await?.ok_or_else(not_found)?;
        check_order(&first, &claims.uid, quantity)?;
        let game = live::field(&first, "marketplace_game", 40);
        let draft = match listings::prepare_listing(&state, &claims, &listing_body(&first, quantity, &payload), &game).await? {
            Prepared::Insert(draft) => draft,
            Prepared::CardtraderOnly(_) => return Err(ApiError::internal("Buy order listings are Pokoin listings.")),
        };

        let mut tx = state.write_db().begin().await?;
        let locked: Option<String> = sqlx::query_scalar("select buyer_uid from public.marketplace_buy_orders where id = $1 for update")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
        if locked.is_none() {
            return Err(not_found());
        }
        // Recounted inside the lock: two sells for the last copy cannot both pass.
        let order = fetch_order(&mut *tx, id).await?.ok_or_else(not_found)?;
        check_order(&order, &claims.uid, quantity)?;
        if live::number(&order["price_pkn"]) != live::number(&first["price_pkn"]) {
            return Err(conflict("buy_order_changed"));
        }
        let (row, queued) = listings::insert_listing(&state, &mut tx, &claims, &draft).await?;
        let listing_id = uuid::Uuid::parse_str(&live::field(&row, "id", 80)).map_err(|_| ApiError::internal("Pokoin did not confirm the listing."))?;
        sqlx::query(
            "insert into public.marketplace_buy_order_fills (buy_order_id, listing_id, seller_uid, quantity, price_pkn, seller_message) \
             select o.id, $2, $3, $4, o.price_pkn, $5 from public.marketplace_buy_orders o where o.id = $1",
        )
        .bind(id)
        .bind(listing_id)
        .bind(&claims.uid)
        .bind(quantity as i32)
        .bind(&seller_note)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;

        if let Err(error) = listings::finish_created(&state, &claims, &row, queued, &draft).await {
            tracing::warn!(order = %id, listing = %listing_id, error = %error.message, "buy order listing committed; cache refresh failed");
        }
        let mailer = state.clone();
        let mailed = order.clone();
        tokio::spawn(async move {
            if let Err(error) = email_buyer(&mailer, &mailed, quantity, &seller_note).await {
                tracing::warn!(error = %error, "buy order fill email not sent");
            }
        });

        let after = fetch_order(state.write_db(), id).await?.ok_or_else(not_found)?;
        let fills = fills_for(state.write_db(), &[id]).await?;
        Ok(json!({ "listing_id": listing_id.to_string(), "buy_order": mine_json(&after, &fills, Some(&claims.uid)) }))
    }
    .await;
    match result {
        Ok(value) => created_json(value),
        Err(error) => error_response(error),
    }
}

// ------------------------------------------------------------ the starting offer

/// Pokoin's own standing offer: every card, in every condition and language,
/// at this price. It is not a row in `marketplace_buy_orders`; like every
/// offer in version 1 it moves no money. Selling into it lists the card at
/// this price and tells Pokoin, who buys it through the cart.
pub const HOUSE_PRICE_PKN: f64 = 1.0;

/// Where "a seller sold into the starting offer" is mailed.
const HOUSE_BUYER_EMAIL: &str = crate::email::DEFAULT_EARN_PKN_TO;

/// A validated `POST /api/marketplace-buy-orders/house/sell` body: a buy
/// order's card, facets and display fields with the same cleaning and limits.
/// The price and the duration are the house's, whatever the body says.
pub fn parse_house_sale(body: &Value) -> Result<NewOrder, ApiError> {
    if !body.is_object() {
        return Err(bad("invalid_body"));
    }
    let mut fixed = body.clone();
    fixed["price_pkn"] = json!(HOUSE_PRICE_PKN);
    fixed["days"] = Value::Null;
    if fixed.get("quantity").is_none_or(Value::is_null) {
        fixed["quantity"] = json!(1);
    }
    parse_new_order(&fixed)
}

/// The listing body for a sale into the starting offer: `listing_body` over an
/// order-shaped row, marked with its own source and no order id.
pub fn house_listing_body(sale: &NewOrder, game: &str, seller: &Value) -> Value {
    let order = json!({
        "card_id": sale.card_id,
        "condition": sale.condition,
        "language": sale.language,
        "reverse": sale.reverse,
        "first_edition": sale.first_edition,
        "price_pkn": HOUSE_PRICE_PKN,
        "card_name": sale.card_name,
        "card_image_url": sale.card_image_url,
        "set_name": sale.set_name,
        "collector_number": sale.collector_number,
        "marketplace_game": game,
    });
    let mut body = listing_body(&order, sale.quantity, seller);
    body["source"] = json!("buy_order_house");
    body["sourceListingId"] = json!("");
    body
}

/// Tell Pokoin a seller listed into the starting offer, with the seller's note
/// to Pokoin when there is one. Best effort.
async fn email_house(
    state: &DomainState,
    sale: &NewOrder,
    seller_note: &str,
) -> Result<(), String> {
    let message = notify::build_buy_order_fill_email(
        "Pokoin",
        &sale.card_name,
        &sale.card_id,
        HOUSE_PRICE_PKN,
        sale.quantity,
        seller_note,
        notify::HOUSE_NOTE_LABEL,
    );
    crate::email::send_email(
        state.http(),
        crate::email::MARKETPLACE_FROM,
        HOUSE_BUYER_EMAIL,
        &message.subject,
        &message.text,
        &message.html,
    )
    .await
    .map(|_| ())
    .map_err(|error| error.message)
}

/// `POST /api/marketplace-buy-orders/house/sell` — list into Pokoin's
/// starting offer. The listing goes through the normal listing path, so every
/// seller check of `POST /api/marketplace-listings` applies with the same
/// error responses. There is no order row to lock and no fill to record, so an
/// optional `buyer_message` reaches Pokoin in the notification email alone.
pub async fn sell_house(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let result: Result<Value, ApiError> = async {
        let payload: Value = serde_json::from_slice(&body).map_err(|_| bad("invalid_body"))?;
        let sale = parse_house_sale(&payload)?;
        let seller_note =
            rules::parse_buyer_message(&payload["buyer_message"]).map_err(bad)?;
        throttle(&state, "buy-order-sell", &claims.uid).await?;
        let game = listings::request_game(&headers, &uri);
        let draft = match listings::prepare_listing(
            &state,
            &claims,
            &house_listing_body(&sale, &game, &payload),
            &game,
        )
        .await?
        {
            Prepared::Insert(draft) => draft,
            Prepared::CardtraderOnly(_) => {
                return Err(ApiError::internal(
                    "Starting offer listings are Pokoin listings.",
                ))
            }
        };

        let mut tx = state.write_db().begin().await?;
        let (row, queued) = listings::insert_listing(&state, &mut tx, &claims, &draft).await?;
        let listing_id = live::field(&row, "id", 80);
        if listing_id.is_empty() {
            return Err(ApiError::internal("Pokoin did not confirm the listing."));
        }
        tx.commit().await?;

        if let Err(error) = listings::finish_created(&state, &claims, &row, queued, &draft).await {
            tracing::warn!(listing = %listing_id, error = %error.message, "starting offer listing committed; cache refresh failed");
        }
        let mailer = state.clone();
        let mailed = sale.clone();
        tokio::spawn(async move {
            if let Err(error) = email_house(&mailer, &mailed, &seller_note).await {
                tracing::warn!(error = %error, "starting offer email not sent");
            }
        });

        Ok(json!({
            "listing_id": listing_id,
            "price_pkn": HOUSE_PRICE_PKN,
            "quantity": sale.quantity,
        }))
    }
    .await;
    match result {
        Ok(value) => created_json(value),
        Err(error) => error_response(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000-0000-4000-8000-00000000000a";

    #[test]
    fn a_sale_into_the_starting_offer_is_always_one_pkn() {
        // The body cannot name its own price or duration, and quantity defaults to 1.
        let sale = parse_house_sale(&json!({
            "card_id": "202", "condition": "sp", "language": "it", "price_pkn": 5000, "days": 7,
            "card_name": "Pikachu",
        }))
        .unwrap();
        assert_eq!(
            (sale.price_pkn, sale.quantity, sale.days),
            (HOUSE_PRICE_PKN, 1, None)
        );
        assert_eq!((sale.condition, sale.language.as_str()), ("SP", "IT"));
        // The same validation as a buy order.
        for (key, value, code) in [
            ("card_id", json!(" "), "invalid_card"),
            ("condition", json!("Mint"), "invalid_condition"),
            ("language", json!("XX"), "invalid_language"),
            ("quantity", json!(11), "invalid_quantity"),
        ] {
            let mut body = json!({ "card_id": "202", "condition": "NM", "language": "EN" });
            body[key] = value;
            let error = parse_house_sale(&body).unwrap_err();
            assert_eq!(
                (error.status, error.code.as_deref()),
                (StatusCode::BAD_REQUEST, Some(code)),
                "{key}"
            );
        }
        assert!(parse_house_sale(&json!([])).is_err());

        let listing = house_listing_body(
            &sale,
            "pokemon",
            &json!({ "sellerComment": "sleeved", "pricePkn": 9 }),
        );
        assert_eq!(listing["pricePkn"], json!(HOUSE_PRICE_PKN));
        assert_eq!(listing["source"], json!("buy_order_house"));
        assert_eq!(listing["sourceListingId"], json!(""));
        assert_eq!(listing["cardId"], json!("202"));
        assert_eq!(listing["condition"], json!("SP"));
        assert_eq!(listing["language"], json!("IT"));
        assert_eq!(listing["quantityAvailable"], json!(1));
        assert_eq!(listing["marketplaceGame"], json!("pokemon"));
        assert_eq!(listing["sellerComment"], json!("sleeved"));
    }

    fn body() -> Value {
        json!({
            "card_id": "202", "condition": "nm", "language": "jp", "reverse": true, "price_pkn": 1200, "quantity": 2, "days": 7,
            "card_name": "Pikachu", "card_image_url": "https://x/y.jpg", "set_name": "Base Set", "collector_number": "58/102",
        })
    }

    #[test]
    fn a_new_order_is_cleaned_and_validated() {
        let order = parse_new_order(&body()).unwrap();
        assert_eq!(order.condition, "NM");
        assert_eq!(order.language, "JP");
        assert!(order.reverse && !order.first_edition);
        assert_eq!(
            (order.price_pkn, order.quantity, order.days),
            (1200.0, 2, Some(7))
        );
        let mut forever = body();
        forever["days"] = Value::Null;
        assert_eq!(parse_new_order(&forever).unwrap().days, None);
        for (key, value, code) in [
            ("card_id", json!("  "), "invalid_card"),
            ("condition", json!("Mint"), "invalid_condition"),
            ("language", json!("XX"), "invalid_language"),
            ("price_pkn", json!(0), "invalid_price"),
            ("price_pkn", json!("nope"), "invalid_price"),
            (
                "price_pkn",
                json!(rules::MAX_PRICE_PKN * 2.0),
                "invalid_price",
            ),
            ("quantity", json!(11), "invalid_quantity"),
            ("quantity", json!(0), "invalid_quantity"),
            ("days", json!(3), "invalid_days"),
        ] {
            let mut bad_body = body();
            bad_body[key] = value;
            let error = parse_new_order(&bad_body).unwrap_err();
            assert_eq!(
                (error.status, error.code.as_deref()),
                (StatusCode::BAD_REQUEST, Some(code)),
                "{key}"
            );
            assert_eq!(error.message, code);
        }
        // `days` must be sent, even as null.
        let mut missing = body();
        missing.as_object_mut().unwrap().remove("days");
        assert_eq!(
            parse_new_order(&missing).unwrap_err().code.as_deref(),
            Some("invalid_days")
        );
        assert_eq!(
            parse_new_order(&json!([])).unwrap_err().code.as_deref(),
            Some("invalid_body")
        );
    }

    #[test]
    fn a_patch_carries_only_what_was_sent() {
        assert_eq!(
            parse_patch(&json!({ "price_pkn": 5, "days": null })).unwrap(),
            OrderPatch {
                price_pkn: Some(5.0),
                quantity: None,
                days: Some(None)
            }
        );
        assert_eq!(
            parse_patch(&json!({ "quantity": 3 })).unwrap().quantity,
            Some(3)
        );
        assert_eq!(
            parse_patch(&json!({})).unwrap_err().code.as_deref(),
            Some("nothing_to_update")
        );
        assert_eq!(
            parse_patch(&json!({ "quantity": 99 }))
                .unwrap_err()
                .code
                .as_deref(),
            Some("invalid_quantity")
        );
        assert_eq!(
            parse_patch(&json!({ "days": 2 }))
                .unwrap_err()
                .code
                .as_deref(),
            Some("invalid_days")
        );
    }

    #[test]
    fn the_sell_listing_is_the_order_plus_only_free_seller_fields() {
        let order = json!({
            "id": ID, "card_id": "202", "condition": "SP", "language": "IT", "reverse": false, "first_edition": true,
            "price_pkn": 300, "card_name": "Pikachu", "card_image_url": "i", "set_name": "Base", "collector_number": "58/102",
            "marketplace_game": "pokemon",
        });
        let seller = json!({
            "sellerCountry": "DK", "location": "box·1", "sellerComment": "hi",
            // The order fixes these; the seller cannot change them.
            "pricePkn": 1, "condition": "NM", "language": "EN", "graded": true, "status": "paused",
            "targets": { "cardtrader": true }, "reserve": true, "quantityAvailable": 99, "source": "x",
        });
        let body = listing_body(&order, 2, &seller);
        assert_eq!(body["cardId"], "202");
        assert_eq!(body["pricePkn"], 300);
        assert_eq!(body["condition"], "SP");
        assert_eq!(body["language"], "IT");
        assert_eq!(body["firstEdition"], true);
        assert_eq!(body["quantityAvailable"], 2);
        assert_eq!(body["source"], "buy_order");
        assert_eq!(body["sourceListingId"], ID);
        assert_eq!(body["status"], "active");
        assert_eq!(body["sellerCountry"], "DK");
        assert_eq!(body["location"], "box·1");
        for key in ["graded", "targets", "reserve"] {
            assert!(body.get(key).is_none(), "{key} must not pass through");
        }
    }

    #[test]
    fn board_cursors_round_trip_and_reject_the_other_sort() {
        let created = "2026-11-11T10:00:00.123456Z";
        let row = json!({ "id": ID, "created_cursor": created, "price_text": "12.5" });
        assert_eq!(
            parse_cursor(&next_cursor(&row, false), false).unwrap(),
            Cursor::Recent {
                created: created.into(),
                id: uuid::Uuid::parse_str(ID).unwrap()
            }
        );
        assert_eq!(
            parse_cursor(&next_cursor(&row, true), true).unwrap(),
            Cursor::Price {
                price: "12.5".into(),
                created: created.into(),
                id: uuid::Uuid::parse_str(ID).unwrap()
            }
        );
        assert!(parse_cursor(&next_cursor(&row, true), false).is_err());
        assert!(parse_cursor(&next_cursor(&row, false), true).is_err());
        for junk in [
            "",
            "x|y",
            "2026-11-11T10:00:00Z|nope",
            "NaN|2026-11-11T10:00:00Z|nope",
        ] {
            assert!(
                parse_cursor(junk, false).is_err() && parse_cursor(junk, true).is_err(),
                "{junk}"
            );
        }
    }

    #[test]
    fn buyer_views_never_leak_the_buyer_uid_or_other_sellers_fills() {
        let row = json!({
            "id": ID, "buyer_uid": "secret-uid", "card_id": "202", "price_pkn": 5, "remaining": 1, "quantity": 2, "state": "open",
            "buyer_name": "Ash", "created_at": "t", "expires_at": null,
        });
        let fills = [
            json!({ "listing_id": "l1", "seller_uid": "s1", "quantity": 1, "price_pkn": 5, "created_at": "t", "listing_status": "active" }),
            json!({ "listing_id": "l2", "seller_uid": "s2", "quantity": 1, "price_pkn": 5, "created_at": "t", "listing_status": "sold_out" }),
        ];
        assert!(item_json(&row).get("buyer_uid").is_none());
        let all = mine_json(&row, &fills, None);
        assert_eq!(all["fills"].as_array().unwrap().len(), 2);
        assert!(all["fills"][0].get("seller_uid").is_none());
        let only = mine_json(&row, &fills, Some("s2"));
        assert_eq!(only["fills"].as_array().unwrap().len(), 1);
        assert_eq!(only["fills"][0]["listing_id"], "l2");
        assert_eq!(only["quantity"], 2);
        assert_eq!(only["state"], "open");
    }

    #[test]
    fn a_duplicate_conflict_names_the_existing_order() {
        let response =
            error_response(conflict("duplicate_buy_order").with_meta(json!({ "id": ID })));
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn a_note_shows_on_the_fill_that_carried_it() {
        let row = json!({ "id": ID, "quantity": 2, "remaining": 1, "state": "open" });
        let fills = [
            json!({ "listing_id": "l1", "seller_uid": "s1", "seller_message": "ship Monday" }),
            // A fill read before the column existed, or one with no note.
            json!({ "listing_id": "l2", "seller_uid": "s2", "seller_message": "" }),
            json!({ "listing_id": "l3", "seller_uid": "s3" }),
        ];
        let as_buyer = mine_json(&row, &fills, None);
        assert_eq!(as_buyer["fills"][0]["seller_message"], "ship Monday");
        assert_eq!(as_buyer["fills"][1]["seller_message"], "");
        assert_eq!(as_buyer["fills"][2]["seller_message"], "");
        let as_seller = mine_json(&row, &fills, Some("s2"));
        assert_eq!(as_seller["fills"].as_array().unwrap().len(), 1);
        assert_eq!(as_seller["fills"][0]["seller_message"], "");
        assert!(
            !mine_json(&row, &fills, Some("s2"))
                .to_string()
                .contains("ship Monday"),
            "a seller never reads another seller's note"
        );
    }

    #[test]
    fn the_note_stays_out_of_the_starting_offer_listing_body() {
        let payload = json!({
            "card_id": "202", "condition": "NM", "language": "EN", "quantity": 1,
            "sellerComment": "sleeved", "buyer_message": "ship Monday, please",
        });
        let sale = parse_house_sale(&payload).unwrap();
        assert_eq!(
            rules::parse_buyer_message(&payload["buyer_message"]).unwrap(),
            "ship Monday, please"
        );
        let listing = house_listing_body(&sale, "pokemon", &payload);
        assert_eq!(listing["sellerComment"], "sleeved");
        assert!(listing.get("buyer_message").is_none());
        assert!(!listing.to_string().contains("ship Monday"));
    }
}
