//! `GET|OPTIONS /api/marketplace-recommendations` — port of
//! `marketplace-recommendations.js` (personal rails of buyable cards).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{game, http, limits, security, RouteState};
use serde_json::{json, Map, Value};
use sqlx::PgPool;

use super::common::with_headers;
use super::recommend::{self as rec, card_id_of, text_of, Affinity, Bought, Ranked};
use crate::shared::{js, react_card};

const REQUESTS_PER_MINUTE: i64 = 60;
const MAX_SELLER_SHELVES: usize = 2;

const LISTING_COLUMNS: &str = "
  l.id::text as id, l.card_id::text as card_id, l.seller_uid, l.seller_name, l.seller_country,
  l.seller_reputation_label, l.condition, l.language, l.price_pkn, l.quantity_available,
  l.signed, l.reverse, l.first_edition, l.sealed, l.graded, l.grading_company, l.grade,
  l.reserve_available, l.nft_available, l.source, l.card_name, l.card_image_url,
  l.set_name, l.collector_number, l.marketplace_game";

const BUYABLE: &str = "
  l.status = 'active' and l.quantity_available > 0 and l.price_pkn > 0
  and l.shipping_available = true and l.card_id ~ '^[0-9]+$'
  and coalesce(nullif(l.marketplace_game, ''), 'pokemon') = 'pokemon'";

const CARD_COLUMNS: &str = "
  c.card_id::text as card_id, c.ct_id, c.name, c.set_name, c.expansion_name, c.card_number,
  c.rarity, c.rarity_kind, c.product_type, c.item_kind, c.image_url, c.cdn_image_url,
  c.homepage_image_url, c.artist, c.illustrator, c.pokedex_num, c.version, c.art_layout";

const PUBLIC_PROFILE_TTL_SEC: u64 = 6 * 60 * 60;

fn cors_headers() -> Vec<(&'static str, &'static str)> {
    let mut headers: Vec<(&str, &str)> = react_card::set_cors_headers().to_vec();
    headers.retain(|(k, _)| *k != "access-control-allow-methods" && *k != "access-control-allow-headers");
    headers.push(("access-control-allow-methods", "GET, OPTIONS"));
    headers.push(("access-control-allow-headers", "Authorization, Content-Type, x-pokoin-game, x-pokoin-host, x-marketplace-game"));
    headers
}

fn send_private(status: StatusCode, body: Value, extra: &[(&str, &str)]) -> Response {
    let mut headers = cors_headers();
    headers.push(("cache-control", "private, no-store"));
    headers.extend_from_slice(extra);
    with_headers(http::json(status, body), &headers)
}

fn is_missing_relation(error: &sqlx::Error) -> bool {
    let Some(db) = error.as_database_error() else { return false };
    if db.code().as_deref() == Some("42P01") {
        return true;
    }
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)relation .* does not exist").unwrap());
    RE.is_match(db.message())
}

fn db_code(error: &sqlx::Error) -> Option<String> {
    error.as_database_error().and_then(|d| d.code()).map(|c| c.into_owned())
}

// --- buyable pool -------------------------------------------------------------

#[derive(Clone)]
struct Pool {
    at: Instant,
    cards: Arc<Vec<Value>>,
    by_id: Arc<HashMap<String, Value>>,
}

static POOL: LazyLock<Mutex<Option<Pool>>> = LazyLock::new(|| Mutex::new(None));
static POOL_FLIGHT: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn pool_ttl() -> Duration {
    let ms = std::env::var("POKOIN_RECOMMEND_POOL_TTL_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(3 * 60 * 1000);
    Duration::from_millis(ms)
}

fn fresh_pool() -> Option<Pool> {
    let pool = POOL.lock().unwrap_or_else(|p| p.into_inner()).clone()?;
    (!pool.cards.is_empty() && pool.at.elapsed() < pool_ttl()).then_some(pool)
}

async fn query_pool(db: &PgPool) -> Result<Vec<Value>, sqlx::Error> {
    let with_extras = format!(
        "
    with listed as (
      select l.card_id::bigint as card_id, min(l.price_pkn) as min_price,
             count(*)::int as offer_count, sum(l.quantity_available)::int as stock
        from public.marketplace_user_listings l
       where {BUYABLE}
       group by 1
    )
    select {CARD_COLUMNS},
           listed.min_price, listed.offer_count, listed.stock,
           coalesce(h.hot_score_24h, 0) as hot_24h, coalesce(h.hot_score_7d, 0) as hot_7d,
           u.canonical_path
      from listed
      join public.marketplace_search_candidates c on c.card_id = listed.card_id
      left join public.marketplace_hot_blueprints h on h.blueprint_id = c.ct_id
      left join lateral (
        select canonical_path from public.marketplace_card_urls u
         where u.card_id = c.card_id and u.language = 'en'
         order by canonical_path limit 1
      ) u on true"
    );
    match pg::pool_rows(db, &with_extras, &[]).await {
        Ok(rows) => Ok(rows),
        Err(error) if is_missing_relation(&error) => {
            static AS: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?-u:\b)as \w+").unwrap());
            let group_by = AS.replace_all(CARD_COLUMNS, "");
            let plain = format!(
                "
      select {CARD_COLUMNS}, min(l.price_pkn) as min_price, count(*)::int as offer_count,
             sum(l.quantity_available)::int as stock, 0 as hot_24h, 0 as hot_7d, null as canonical_path
        from public.marketplace_user_listings l
        join public.marketplace_search_candidates c on c.card_id = l.card_id::bigint
       where {BUYABLE}
       group by {group_by}"
            );
            pg::pool_rows(db, &plain, &[]).await
        }
        Err(error) => Err(error),
    }
}

/// `loadPool()` — shared per process for a few minutes, one refresh in flight.
async fn load_pool(db: &PgPool) -> Result<Pool, sqlx::Error> {
    if let Some(pool) = fresh_pool() {
        return Ok(pool);
    }
    let _flight = POOL_FLIGHT.lock().await;
    if let Some(pool) = fresh_pool() {
        return Ok(pool);
    }
    match query_pool(db).await {
        Ok(rows) => {
            let cards: Vec<Value> = rows
                .into_iter()
                .map(|mut row| {
                    let id = card_id_of(&row);
                    row["card_id"] = json!(id);
                    row
                })
                .filter(|row| !js::string_or_empty(row.get("card_id")).is_empty())
                .collect();
            let by_id = cards.iter().map(|c| (js::string_or_empty(c.get("card_id")), c.clone())).collect();
            let pool = Pool { at: Instant::now(), cards: Arc::new(cards), by_id: Arc::new(by_id) };
            *POOL.lock().unwrap_or_else(|p| p.into_inner()) = Some(pool.clone());
            Ok(pool)
        }
        Err(error) => {
            // Serve a stale pool rather than nothing when one refresh fails.
            let stale = POOL.lock().unwrap_or_else(|p| p.into_inner()).clone();
            match stale {
                Some(pool) if !pool.cards.is_empty() => Ok(pool),
                _ => Err(error),
            }
        }
    }
}

// --- the account's own signals -------------------------------------------------

struct CartLine {
    card_id: String,
    seller_uid: String,
    listing_id: String,
    selected: bool,
}

struct Cart {
    items: Vec<CartLine>,
    saved: Vec<CartLine>,
}

fn clean_cart_rows(list: Option<&Value>, max: usize) -> Vec<CartLine> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for raw in list.and_then(Value::as_array).into_iter().flatten() {
        if !raw.is_object() {
            continue;
        }
        let id = text_of(raw.get("id"), 80);
        let card_id = text_of(raw.get("cardId").filter(|v| !v.is_null()).or(raw.pointer("/card/id")), 20);
        if id.is_empty() || card_id.is_empty() || !card_id.bytes().all(|b| b.is_ascii_digit()) || !seen.insert(id) {
            continue;
        }
        out.push(CartLine {
            card_id,
            seller_uid: text_of(raw.get("sellerUid"), 160),
            listing_id: text_of(raw.get("listingId"), 80),
            selected: raw.get("selected") != Some(&json!(false)),
        });
        if out.len() >= max {
            break;
        }
    }
    out
}

async fn read_cart(db: &PgPool, uid: &str) -> Result<Cart, sqlx::Error> {
    let sql = "
  select items, saved, gift, rev, updated_at
    from public.marketplace_user_carts
   where user_uid = $1
   limit 1";
    match pg::pool_rows(db, sql, &[Bind::Text(uid.to_owned())]).await {
        Ok(rows) => {
            let row = rows.into_iter().next().unwrap_or(Value::Null);
            Ok(Cart { items: clean_cart_rows(row.get("items"), 400), saved: clean_cart_rows(row.get("saved"), 200) })
        }
        Err(error) if is_missing_relation(&error) => Ok(Cart { items: Vec::new(), saved: Vec::new() }),
        Err(error) => Err(error),
    }
}

fn ids_from(value: Option<&Value>) -> Vec<String> {
    let parts: Vec<String> = match value {
        Some(Value::Array(items)) => items.iter().map(|v| if v.is_null() { String::new() } else { js::js_string(v) }).collect(),
        Some(Value::Null) | None => Vec::new(),
        Some(other) => js::js_string(other).split(',').map(str::to_owned).collect(),
    };
    rec::parse_ids(parts, 24)
}

async fn read_recent_ids(db: &PgPool, uid: &str) -> Vec<String> {
    let sql = "select card_ids from public.marketplace_user_recents where user_uid = $1 and game = 'pokemon' limit 1";
    match pg::pool_rows(db, sql, &[Bind::Text(uid.to_owned())]).await {
        Ok(rows) => ids_from(rows.first().and_then(|r| r.get("card_ids"))),
        Err(_) => Vec::new(),
    }
}

async fn read_watch_ids(db: &PgPool, uid: &str) -> Vec<String> {
    let sql = "select watchlist_card_ids from public.poko_user_personal_snapshot where firebase_uid = $1 limit 1";
    match pg::pool_rows(db, sql, &[Bind::Text(uid.to_owned())]).await {
        Ok(rows) => ids_from(rows.first().and_then(|r| r.get("watchlist_card_ids"))),
        Err(_) => Vec::new(),
    }
}

async fn read_bought(state: &RouteState, uid: &str) -> Vec<Bought> {
    let firestore = match state.accounts.firestore() {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let query = pokoin_accounts::Query::collection("orders").where_eq("uid", uid).limit(200);
    match firestore.run_query(&query).await {
        Ok(docs) => {
            let orders: Vec<Value> = docs.iter().map(|d| d.to_plain_json()).collect();
            rec::bought_card_ids(&orders, 24)
        }
        Err(error) => {
            tracing::warn!(message = %error.body(), "marketplace-recommendations orders skipped");
            Vec::new()
        }
    }
}

struct Account {
    cart: Option<Cart>,
    recent: Vec<String>,
    watch: Vec<String>,
    bought: Vec<Bought>,
}

async fn read_account_signals(state: &RouteState, db: &PgPool, uid: &str) -> Account {
    if uid.is_empty() {
        return Account { cart: None, recent: Vec::new(), watch: Vec::new(), bought: Vec::new() };
    }
    let (cart, recent, watch, bought) = tokio::join!(read_cart(db, uid), read_recent_ids(db, uid), read_watch_ids(db, uid), read_bought(state, uid));
    Account { cart: cart.ok(), recent, watch, bought }
}

// --- per-request reads -----------------------------------------------------------

async fn read_cards(db: &PgPool, ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let numbers: Vec<i64> = ids.iter().filter_map(|id| id.parse().ok()).collect();
    let sql = format!(
        "select {CARD_COLUMNS}, u.canonical_path
       from public.marketplace_search_candidates c
       left join lateral (
         select canonical_path from public.marketplace_card_urls u
          where u.card_id = c.card_id and u.language = 'en'
          order by canonical_path limit 1
       ) u on true
      where c.card_id = any($1::bigint[])"
    );
    let rows = match pg::pool_rows(db, &sql, &[Bind::BigIntArray(numbers.clone())]).await {
        Ok(rows) => rows,
        Err(error) if is_missing_relation(&error) => {
            let plain = format!("select {CARD_COLUMNS} from public.marketplace_search_candidates c where c.card_id = any($1::bigint[])");
            pg::pool_rows(db, &plain, &[Bind::BigIntArray(numbers)]).await?
        }
        Err(error) => return Err(error),
    };
    Ok(rows
        .into_iter()
        .map(|mut row| {
            let id = card_id_of(&row);
            row["card_id"] = json!(id);
            row
        })
        .collect())
}

async fn read_offers(db: &PgPool, card_ids: &[String]) -> Result<HashMap<String, Vec<Value>>, sqlx::Error> {
    let mut by_card: HashMap<String, Vec<Value>> = HashMap::new();
    if card_ids.is_empty() {
        return Ok(by_card);
    }
    let sql = format!(
        "select {LISTING_COLUMNS}
       from public.marketplace_user_listings l
      where l.card_id = any($1::text[]) and {BUYABLE}
      order by l.card_id, l.price_pkn asc
      limit 4000"
    );
    for row in pg::pool_rows(db, &sql, &[Bind::TextArray(card_ids.to_vec())]).await? {
        by_card.entry(js::string_or_empty(row.get("card_id"))).or_default().push(row);
    }
    Ok(by_card)
}

struct Taste {
    species: Vec<f64>,
    names: Vec<String>,
    artists: Vec<String>,
    sets: Vec<String>,
    languages: Vec<String>,
    conditions: Vec<String>,
}

fn lower_unique(list: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    list.iter().map(|v| v.trim().to_lowercase()).filter(|v| !v.is_empty() && seen.insert(v.clone())).collect()
}

async fn read_seller_listings(db: &PgPool, seller_uid: &str, taste: &Taste) -> Result<Vec<Value>, sqlx::Error> {
    let sql = format!(
        "select {LISTING_COLUMNS}
       from public.marketplace_user_listings l
       join public.marketplace_search_candidates c on c.card_id = l.card_id::bigint
      where l.seller_uid = $1 and {BUYABLE}
      order by (
                 (case when lower(c.name) = any($3::text[]) then 4 else 0 end)
               + (case when c.pokedex_num = any($2::int[]) then 3 else 0 end)
               + (case when lower(c.set_name) = any($5::text[]) then 3 else 0 end)
               + (case when lower(l.language) = any($6::text[]) then 2 else 0 end)
               + (case when lower(l.condition) = any($7::text[]) then 1 else 0 end)
               + (case when lower(coalesce(nullif(c.artist, ''), c.illustrator, '')) = any($4::text[]) then 1 else 0 end)
               ) desc,
               l.price_pkn asc
      limit 600"
    );
    let species: Vec<i64> = taste.species.iter().filter(|n| js::is_safe_integer(**n) && **n > 0.0 && **n <= 1025.0).map(|n| *n as i64).collect();
    pg::pool_rows(
        db,
        &sql,
        &[
            Bind::Text(seller_uid.to_owned()),
            Bind::BigIntArray(species),
            Bind::TextArray(lower_unique(&taste.names)),
            Bind::TextArray(lower_unique(&taste.artists)),
            Bind::TextArray(lower_unique(&taste.sets)),
            Bind::TextArray(lower_unique(&taste.languages)),
            Bind::TextArray(lower_unique(&taste.conditions)),
        ],
    )
    .await
}

async fn read_listings_by_id(db: &PgPool, ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    let wanted: Vec<String> = ids.iter().map(|id| id.trim().to_owned()).filter(|id| !id.is_empty() && id.encode_utf16().count() <= 80).take(400).collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!("select {LISTING_COLUMNS} from public.marketplace_user_listings l where l.id::text = any($1::text[])");
    pg::pool_rows(db, &sql, &[Bind::TextArray(wanted)]).await
}

async fn read_co_carted(db: &PgPool, card_ids: &[String], uid: &str) -> Result<Vec<(String, f64)>, sqlx::Error> {
    if card_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = "select id::text as card_id, count(*)::int as carts
         from public.marketplace_user_carts carts, unnest(carts.card_ids) as id
        where carts.card_ids && $1::bigint[]
          and carts.user_uid <> $2
          and carts.updated_at > now() - interval '120 days'
          and not (id = any($1::bigint[]))
        group by id
        order by carts desc
        limit 200";
    let numbers: Vec<i64> = card_ids.iter().filter_map(|id| id.parse().ok()).collect();
    match pg::pool_rows(db, sql, &[Bind::BigIntArray(numbers), Bind::Text(uid.to_owned())]).await {
        Ok(rows) => Ok(rows
            .iter()
            .map(|r| {
                let n = js::number(r.get("carts"));
                (js::js_string(r.get("card_id").unwrap_or(&Value::Null)), if n.is_finite() && n != 0.0 { n } else { 0.0 })
            })
            .collect()),
        Err(error) if is_missing_relation(&error) => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

// --- seller profiles (`_seller_profile_cache.js`) -------------------------------

#[derive(Clone, Default)]
struct Profile {
    display_name: String,
    username: String,
    accepts_pkn: bool,
}

fn profile_key(uid: &str) -> String {
    format!("pokoin:seller:v1:{}:profile", js::clean_text_str(uid, 160))
}

fn profile_from_json(value: &Value) -> Option<Profile> {
    let obj = value.as_object()?;
    let valid = obj.get("displayName").is_some_and(|v| !v.is_null()) || obj.get("username").is_some_and(|v| !v.is_null()) || obj.get("acceptsPkn").is_some_and(Value::is_boolean);
    valid.then(|| Profile {
        display_name: js::string_or_empty(obj.get("displayName")),
        username: js::string_or_empty(obj.get("username")),
        accepts_pkn: obj.get("acceptsPkn") != Some(&json!(false)),
    })
}

async fn seller_profiles(state: &RouteState, uids: &[String]) -> HashMap<String, Profile> {
    let mut wanted: Vec<String> = Vec::new();
    for uid in uids {
        let clean = js::clean_text_str(uid, 160);
        if !clean.is_empty() && !wanted.contains(&clean) {
            wanted.push(clean);
        }
    }
    let mut profiles = HashMap::new();
    if wanted.is_empty() {
        return profiles;
    }
    let mut redis = state.api.redis().await;
    let mut missing = Vec::new();
    for uid in &wanted {
        let cached: Option<String> = match redis.as_mut() {
            Some(conn) => redis::cmd("GET").arg(profile_key(uid)).query_async(conn).await.ok().flatten(),
            None => None,
        };
        match cached.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).and_then(|v| profile_from_json(&v)) {
            Some(profile) => {
                profiles.insert(uid.clone(), profile);
            }
            None => missing.push(uid.clone()),
        }
    }
    if missing.is_empty() {
        return profiles;
    }
    let Ok(firestore) = state.accounts.firestore() else { return profiles };
    for uid in missing {
        let doc = match firestore.doc(format!("users/{uid}")).get().await {
            Ok(Some(doc)) => doc.to_plain_json(),
            Ok(None) => continue,
            Err(_) => return profiles,
        };
        let username = doc.get("username").filter(|v| js::truthy(Some(v))).or(doc.get("usernameLower"));
        let profile = Profile {
            display_name: js::clean_text(doc.get("displayName"), 120),
            username: js::clean_text(username, 120),
            accepts_pkn: doc.get("acceptsPkn") != Some(&json!(false)),
        };
        if let Some(conn) = redis.as_mut() {
            let body = json!({ "displayName": profile.display_name, "username": profile.username, "acceptsPkn": profile.accepts_pkn }).to_string();
            let _: Result<(), _> = redis::cmd("SETEX").arg(profile_key(&uid)).arg(PUBLIC_PROFILE_TTL_SEC).arg(body).query_async(conn).await;
        }
        profiles.insert(uid, profile);
    }
    profiles
}

// --- output -----------------------------------------------------------------------

fn public_name(value: &str) -> String {
    let name = value.trim();
    if !name.is_empty() && !name.contains('@') { js::slice_utf16(name, 120) } else { String::new() }
}

fn s(row: &Value, key: &str) -> Value {
    row.get(key).filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!(""))
}

fn offer_json(row: &Value, profile: Option<&Profile>) -> Value {
    let price = js::number(row.get("price_pkn"));
    let name = {
        let from_profile = profile.map(|p| public_name(&p.display_name)).unwrap_or_default();
        if from_profile.is_empty() { public_name(&js::string_or_empty(row.get("seller_name"))) } else { from_profile }
    };
    let quantity = js::number(row.get("quantity_available"));
    json!({
        "id": row.get("id").cloned().unwrap_or(Value::Null),
        "cardId": row.get("card_id").cloned().unwrap_or(Value::Null),
        "sellerUid": row.get("seller_uid").cloned().unwrap_or(Value::Null),
        "sellerName": name,
        "sellerDisplayName": name,
        "sellerUsername": profile.map(|p| public_name(&p.username)).unwrap_or_default(),
        "sellerCountry": s(row, "seller_country"),
        "sellerReputationLabel": s(row, "seller_reputation_label"),
        "sellerAcceptsPkn": profile.map_or(true, |p| p.accepts_pkn),
        "condition": s(row, "condition"),
        "language": s(row, "language"),
        "pricePkn": js::js_json_number(if price.is_finite() && price != 0.0 { price } else { 0.0 }),
        "quantityAvailable": js::js_json_number(if quantity.is_finite() && quantity != 0.0 { quantity } else { 0.0 }),
        "signed": row.get("signed") == Some(&json!(true)),
        "reverse": row.get("reverse") == Some(&json!(true)),
        "firstEdition": row.get("first_edition") == Some(&json!(true)),
        "sealed": row.get("sealed") == Some(&json!(true)),
        "graded": row.get("graded") == Some(&json!(true)),
        "gradingCompany": s(row, "grading_company"),
        "grade": s(row, "grade"),
        "reserveAvailable": row.get("reserve_available") == Some(&json!(true)),
        "nftAvailable": row.get("nft_available") == Some(&json!(true)),
        "source": s(row, "source"),
        "cardName": s(row, "card_name"),
        "cardImageUrl": s(row, "card_image_url"),
        "setName": s(row, "set_name"),
        "collectorNumber": s(row, "collector_number"),
        "marketplaceGame": row.get("marketplace_game").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("pokemon")),
    })
}

fn card_json(card: &Value) -> Value {
    let price = js::number(card.get("min_price"));
    let mut row = card.as_object().cloned().unwrap_or_default();
    row.insert("lowest_price_pkn".into(), if price.is_finite() && price > 0.0 { js::js_json_number(price) } else { Value::Null });
    row.insert("canonical_path".into(), card.get("canonical_path").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("")));
    react_card::to_react_card(&Value::Object(row))
}

struct Item {
    card: Value,
    offer: Option<Value>,
    reason: String,
    purchased_at: Option<f64>,
}

struct Rail {
    head: Map<String, Value>,
    kind: String,
    seller_uid: Option<String>,
    items: Vec<Item>,
    tail: Map<String, Value>,
}

fn rail(id: &str, kind: &str, title: &str, extra: &[(&str, Value)], items: Vec<Item>) -> Rail {
    let mut head = Map::new();
    head.insert("id".into(), json!(id));
    head.insert("kind".into(), json!(kind));
    let mut seller_uid = None;
    for (k, v) in extra {
        if *k == "sellerUid" {
            seller_uid = v.as_str().map(str::to_owned);
            head.insert((*k).into(), v.clone());
        }
    }
    head.insert("title".into(), json!(title));
    for (k, v) in extra {
        if *k != "sellerUid" {
            head.insert((*k).into(), v.clone());
        }
    }
    Rail { head, kind: kind.into(), seller_uid, items, tail: Map::new() }
}

fn items_of(ranked: Vec<Ranked>) -> Vec<Item> {
    ranked.into_iter().map(|r| Item { card: r.card, offer: r.offer, reason: r.reason, purchased_at: None }).collect()
}

struct Signals {
    uid: String,
    cart_ids: Vec<String>,
    seller_uids: Vec<String>,
    listing_ids: Vec<String>,
    recent_ids: Vec<String>,
    watch_ids: Vec<String>,
    bought: Vec<Bought>,
}

fn split_param(value: Option<&str>) -> Vec<String> {
    value.unwrap_or("").split(',').map(|v| v.trim().to_owned()).collect()
}

fn signals_from(q: &http::Query, account: Account, uid: &str) -> Signals {
    let (items, saved) = match account.cart {
        Some(cart) => (cart.items, cart.saved),
        None => (Vec::new(), Vec::new()),
    };
    let mut cart_parts = rec::parse_id_param(q.search_param("cart"), 40);
    cart_parts.extend(items.iter().map(|r| r.card_id.clone()));
    cart_parts.extend(saved.iter().map(|r| r.card_id.clone()));
    let cart_ids = rec::parse_ids(cart_parts, 60);
    let unique_limited = |values: Vec<String>, max_len: usize, take: usize| {
        let mut seen = HashSet::new();
        values.into_iter().filter(|v| !v.is_empty() && v.encode_utf16().count() <= max_len && seen.insert(v.clone())).take(take).collect::<Vec<_>>()
    };
    let mut sellers = split_param(q.search_param("sellers"));
    sellers.extend(items.iter().filter(|r| r.selected).map(|r| r.seller_uid.clone()));
    let mut listings = split_param(q.search_param("listings"));
    listings.extend(items.iter().map(|r| r.listing_id.clone()));
    let mut recent = account.recent;
    recent.extend(rec::parse_id_param(q.search_param("recent"), 24));
    let mut watch = rec::parse_id_param(q.search_param("watch"), 24);
    watch.extend(account.watch);
    Signals {
        uid: uid.to_owned(),
        cart_ids,
        seller_uids: unique_limited(sellers, 160, 6),
        listing_ids: unique_limited(listings, 80, 400),
        recent_ids: rec::parse_ids(recent, 24),
        watch_ids: rec::parse_ids(watch, 24),
        bought: account.bought,
    }
}

async fn recommend(state: &RouteState, db: &PgPool, signals: &Signals, limit: usize) -> Result<Vec<Value>, sqlx::Error> {
    let pool = load_pool(db).await?;
    let mut signal_ids: Vec<String> = Vec::new();
    for id in signals.cart_ids.iter().chain(signals.bought.iter().map(|b| &b.card_id)).chain(&signals.watch_ids).chain(&signals.recent_ids) {
        if !signal_ids.contains(id) {
            signal_ids.push(id.clone());
        }
    }
    let unlisted: Vec<String> = signal_ids.iter().filter(|id| !pool.by_id.contains_key(*id)).take(120).cloned().collect();
    let extra: HashMap<String, Value> = read_cards(db, &unlisted).await?.into_iter().map(|c| (js::string_or_empty(c.get("card_id")), c)).collect();
    let lookup = |id: &str| pool.by_id.get(id).or_else(|| extra.get(id));
    let mut affinity_signals: Vec<(Option<&Value>, &str)> = Vec::new();
    affinity_signals.extend(signals.cart_ids.iter().map(|id| (lookup(id), "cart")));
    affinity_signals.extend(signals.bought.iter().map(|b| (lookup(&b.card_id), "bought")));
    affinity_signals.extend(signals.watch_ids.iter().map(|id| (lookup(id), "watch")));
    affinity_signals.extend(signals.recent_ids.iter().map(|id| (lookup(id), "recent")));
    let affinity: Affinity = rec::build_affinity(&affinity_signals);
    let seen: HashSet<String> = signal_ids.iter().cloned().collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut rails: Vec<Rail> = Vec::new();
    let push = |r: Rail, used: &mut HashSet<String>, rails: &mut Vec<Rail>| {
        if r.items.is_empty() {
            return;
        }
        for item in &r.items {
            used.insert(card_id_of(&item.card));
        }
        rails.push(r);
    };
    let discovery = |used: &HashSet<String>| seen.union(used).cloned().collect::<HashSet<String>>();

    let buy_again: Vec<Item> = signals
        .bought
        .iter()
        .filter(|b| pool.by_id.contains_key(&b.card_id))
        .take(limit)
        .map(|b| Item { card: pool.by_id[&b.card_id].clone(), offer: None, reason: "You bought this before".into(), purchased_at: Some(b.purchased_at) })
        .collect();
    push(rail("buy_again", "buy_again", "Buy it again", &[], buy_again), &mut used, &mut rails);

    let anchors = read_listings_by_id(db, &signals.listing_ids).await.unwrap_or_default();
    let shelves = futures_util::future::try_join_all(signals.seller_uids.iter().take(MAX_SELLER_SHELVES).map(|seller_uid| {
        let own: Vec<Value> = anchors.iter().filter(|r| js::string_or_empty(r.get("seller_uid")) == *seller_uid).cloned().collect();
        let empty = json!({});
        let own_cards: Vec<Value> = own.iter().map(|r| pool.by_id.get(&js::js_string(r.get("card_id").unwrap_or(&Value::Null))).cloned().unwrap_or_else(|| empty.clone())).collect();
        let mut species: Vec<f64> = own_cards.iter().map(|c| match c.get("pokedex_num") { None => f64::NAN, v => js::number(v) }).collect();
        species.extend(affinity.species.keys().map(|k| *k as f64));
        species.truncate(40);
        let pick = |card: &Value, row: &Value, ck: &str, rk: &str| js::string_or_empty(card.get(ck).filter(|v| js::truthy(Some(v))).or(row.get(rk)));
        let mut names: Vec<String> = own.iter().zip(&own_cards).map(|(r, c)| pick(c, r, "name", "card_name")).collect();
        names.extend(affinity.names.values().map(|e| e.label.clone()));
        names.truncate(40);
        let taste = Taste {
            species,
            names,
            artists: affinity.artists.values().map(|e| e.label.clone()).take(40).collect(),
            sets: own.iter().zip(&own_cards).map(|(r, c)| pick(c, r, "set_name", "set_name")).collect(),
            languages: own.iter().map(|r| js::string_or_empty(r.get("language"))).collect(),
            conditions: own.iter().map(|r| js::string_or_empty(r.get("condition"))).collect(),
        };
        let seller_uid = seller_uid.clone();
        async move {
            let listings = read_seller_listings(db, &seller_uid, &taste).await?;
            Ok::<_, sqlx::Error>((seller_uid, listings, own))
        }
    }))
    .await?;
    let exclude_listings: HashSet<String> = signals.listing_ids.iter().cloned().collect();
    let exclude_cards: HashSet<String> = signals.cart_ids.iter().cloned().collect();
    for (seller_uid, listings, own) in shelves {
        let ranked = rec::rank_seller_shelf(&listings, &pool.by_id, &affinity, &exclude_listings, &exclude_cards, &own, limit);
        push(
            rail(
                &format!("parcel:{seller_uid}"),
                "parcel",
                "More from this seller",
                &[("sellerUid", json!(seller_uid)), ("subtitle", json!("Ships in the same parcel as your other cards from them"))],
                items_of(ranked),
            ),
            &mut used,
            &mut rails,
        );
    }

    if !signals.cart_ids.is_empty() {
        let counts = read_co_carted(db, &signals.cart_ids, &signals.uid).await?;
        let ranked = rec::rank_co_carted(&pool.by_id, &counts, &discovery(&used), limit);
        push(rail("also_carted", "also_carted", "Customers who carried these also carried", &[], items_of(ranked)), &mut used, &mut rails);
    }

    let inspired_subtitle = if affinity.size > 0 { format!("More {}", rec::join_labels(&rec::top_labels(&affinity.species, 2))).trim().to_owned() } else { String::new() };
    let ranked = rec::rank_by_affinity(&pool.cards, &affinity, |m| m.contains(&"version") || m.contains(&"species") || m.contains(&"name"), &discovery(&used), limit);
    push(rail("inspired", "inspired", "Inspired by your browsing history", &[("subtitle", json!(inspired_subtitle))], items_of(ranked)), &mut used, &mut rails);

    let artists_subtitle = if affinity.size > 0 { format!("Art by {}", rec::join_labels(&rec::top_labels(&affinity.artists, 2))) } else { String::new() };
    let ranked = rec::rank_by_affinity(&pool.cards, &affinity, |m| m.contains(&"artist"), &discovery(&used), limit);
    push(rail("artists", "artists", "From artists you like", &[("subtitle", json!(artists_subtitle))], items_of(ranked)), &mut used, &mut rails);

    let ranked = rec::rank_trending(&pool.cards, &affinity, &discovery(&used), limit);
    push(rail("trending", "trending", "Trending on Pokoin", &[("subtitle", json!("Most viewed and carted this week"))], items_of(ranked)), &mut used, &mut rails);

    let own_rail = |id: &str, title: &str, ids: &[String]| {
        let items = ids.iter().filter_map(|id| lookup(id)).take(24).map(|card| Item { card: card.clone(), offer: None, reason: String::new(), purchased_at: None }).collect();
        rail(id, id, title, &[], items)
    };
    let watch_rail = own_rail("watchlist", "From your watchlist", &signals.watch_ids);
    let recent_rail = own_rail("recent", "Your recently viewed cards", &signals.recent_ids);
    if !watch_rail.items.is_empty() {
        rails.push(watch_rail);
    }
    if !recent_rail.items.is_empty() {
        rails.push(recent_rail);
    }

    let mut need: Vec<String> = Vec::new();
    for r in &rails {
        for item in &r.items {
            let id = card_id_of(&item.card);
            if item.offer.is_none() && pool.by_id.contains_key(&id) && !need.contains(&id) {
                need.push(id);
            }
        }
    }
    let offers = read_offers(db, &need).await?;
    for r in &mut rails {
        for item in &mut r.items {
            if item.offer.is_none() {
                item.offer = rec::pick_offer(offers.get(&card_id_of(&item.card)).map(Vec::as_slice).unwrap_or(&[]));
            }
        }
    }
    let mut seller_uids: Vec<String> = Vec::new();
    for r in &rails {
        let candidates = r.seller_uid.iter().cloned().chain(r.items.iter().filter_map(|i| i.offer.as_ref()).map(|o| js::string_or_empty(o.get("seller_uid"))));
        for uid in candidates {
            if !uid.is_empty() && !seller_uids.contains(&uid) {
                seller_uids.push(uid);
            }
        }
    }
    let profiles = seller_profiles(state, &seller_uids).await;
    for r in &mut rails {
        if r.kind != "parcel" {
            continue;
        }
        let profile = r.seller_uid.as_ref().and_then(|u| profiles.get(u));
        let sample = r.items.first().and_then(|i| i.offer.clone());
        let username = profile.map(|p| public_name(&p.username)).unwrap_or_default();
        let mut name = profile.map(|p| public_name(&p.display_name)).unwrap_or_default();
        if name.is_empty() {
            name = public_name(&sample.as_ref().map(|o| js::string_or_empty(o.get("seller_name"))).unwrap_or_default());
        }
        let country = sample.as_ref().and_then(|o| o.get("seller_country")).filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!(""));
        let label = if username.is_empty() { name.clone() } else { username.clone() };
        r.tail.insert("sellerUsername".into(), json!(username));
        r.tail.insert("sellerName".into(), json!(name));
        r.tail.insert("sellerCountry".into(), country);
        if !label.is_empty() {
            r.head.insert("title".into(), json!(format!("More from {label}")));
        }
    }
    Ok(rails
        .into_iter()
        .map(|r| {
            let mut out = r.head;
            let items: Vec<Value> = r
                .items
                .iter()
                .map(|item| {
                    let mut entry = Map::new();
                    entry.insert("card".into(), card_json(&item.card));
                    entry.insert(
                        "offer".into(),
                        item.offer.as_ref().map(|o| offer_json(o, profiles.get(&js::string_or_empty(o.get("seller_uid"))))).unwrap_or(Value::Null),
                    );
                    entry.insert("reason".into(), json!(item.reason));
                    if let Some(at) = item.purchased_at.filter(|a| *a != 0.0) {
                        entry.insert("purchasedAt".into(), js::js_json_number(at));
                    }
                    Value::Object(entry)
                })
                .collect();
            out.insert("items".into(), Value::Array(items));
            out.extend(r.tail);
            Value::Object(out)
        })
        .collect())
}

async fn optional_uid(state: &RouteState, headers: &HeaderMap) -> String {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !auth.starts_with("Bearer ") {
        return String::new();
    }
    state.optional_user(headers).await.map(|c| c.uid.trim().to_owned()).unwrap_or_default()
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri) -> Response {
    if method == Method::OPTIONS {
        return with_headers(StatusCode::NO_CONTENT.into_response(), &cors_headers());
    }
    if method != Method::GET {
        return send_private(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "GET only." }), &[("allow", "GET, OPTIONS")]);
    }
    let q = http::Query::from_uri(&uri);
    let pairs = http::header_pairs(&headers);
    let selected = game::normalize_game(&game::parse_game_from_request(&pairs, q.search_param("game"), q.search_param("marketplace_game")));
    if selected != "pokemon" {
        return send_private(StatusCode::OK, json!({ "game": selected, "personalized": false, "rails": [] }), &[]);
    }
    let uid = optional_uid(&state, &headers).await;
    let identity = if uid.is_empty() { security::client_ip(&headers) } else { uid.clone() };
    let verdict = limits::limit_best_effort(&state.api, "recommendations", &identity, REQUESTS_PER_MINUTE, 60).await;
    if !verdict.allowed {
        let retry = if verdict.retry_after_sec > 0 { verdict.retry_after_sec } else { 60 }.to_string();
        return send_private(StatusCode::TOO_MANY_REQUESTS, json!({ "error": "Too many requests. Try again in a minute." }), &[("retry-after", &retry)]);
    }
    // `Math.max(4, Math.min(30, Math.trunc(Number(limit) || DEFAULT_LIMIT)))`.
    let per_rail = {
        let n = match q.search_param("limit") {
            None => 0.0,
            Some(text) => http::js_number(text).unwrap_or(f64::NAN),
        };
        let n = if n.is_nan() || n == 0.0 { rec::DEFAULT_LIMIT as f64 } else { n.trunc() };
        n.clamp(4.0, 30.0) as usize
    };
    let db = state.api.read().clone();
    let account = read_account_signals(&state, &db, &uid).await;
    let signals = signals_from(&q, account, &uid);
    match recommend(&state, &db, &signals, per_rail).await {
        Ok(rails) => {
            let personalized = !signals.cart_ids.is_empty() || !signals.recent_ids.is_empty() || !signals.watch_ids.is_empty() || !signals.bought.is_empty();
            send_private(
                StatusCode::OK,
                json!({
                    "game": selected,
                    "personalized": personalized,
                    "signedIn": !uid.is_empty(),
                    "signals": { "cart": signals.cart_ids.len(), "recent": signals.recent_ids.len(), "watch": signals.watch_ids.len(), "bought": signals.bought.len() },
                    "rails": rails,
                }),
                &[],
            )
        }
        Err(error) => {
            tracing::error!(%error, code = ?db_code(&error), "marketplace-recommendations failed");
            send_private(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Recommendations failed." }), &[])
        }
    }
}
