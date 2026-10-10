//! Native listings reads and writer mutations, plus stock CSV import/export.
use super::private_json;
use crate::domain::stock_csv::{self, ImportOptions, PriceMode};
use crate::error::ApiError;
use crate::state::{AuthedUser, DomainState};
use crate::{listing_live as live, listing_sync as sync};
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use pokoin_api_common::http;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
const LISTING_LIMIT_DEFAULT: i64 = 500;
fn clean_limit(value: Option<&String>) -> i64 {
    value
        .filter(|s| !s.is_empty())
        .and_then(|s| http::js_number(s))
        .filter(|n| n.is_finite())
        .map(|n| (n.trunc() as i64).clamp(1, 1000))
        .unwrap_or(LISTING_LIMIT_DEFAULT)
}
fn clean_offset(value: Option<&String>) -> i64 {
    value
        .and_then(|s| http::js_number(s))
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| (n.trunc() as i64).min(50_000))
        .unwrap_or(0)
}
fn clean_text(value: &str, max: usize) -> String {
    live::text(&json!(value), max)
}
fn clean_listing_id(value: &str) -> String {
    static LISTING_ID: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
        .expect("valid regex")
    });
    let s = clean_text(value, 80);
    if LISTING_ID.is_match(&s) {
        s
    } else {
        String::new()
    }
}
fn bind_json<'a>(
    query: sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments>,
    value: &Value,
) -> sqlx::query::Query<'a, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match value {
        Value::String(s) => query.bind(s.clone()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else {
                query.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::Bool(b) => query.bind(*b),
        Value::Null => query.bind(Option::<String>::None),
        Value::Array(a) => query.bind(
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect::<Vec<_>>(),
        ),
        _ => query.bind(value.to_string()),
    }
}
pub const PKNRESERVE_SELLER_USERNAME: &str = live::RESERVE;
fn query_map(uri: &Uri) -> HashMap<String, String> {
    let q = http::Query::from_uri(uri);
    let mut map = HashMap::new();
    for key in [
        "id",
        "cardId",
        "sellerUid",
        "sellerUsername",
        "game",
        "marketplaceGame",
        "limit",
        "offset",
        "nativeOnly",
        "live",
        "action",
    ] {
        if let Some(value) = q.first(key) {
            map.insert(key.into(), value.into());
        }
    }
    map
}
fn request_game(headers: &HeaderMap, uri: &Uri) -> String {
    let q = http::Query::from_uri(uri);
    pokoin_api_common::game::parse_game_from_request(
        &http::header_pairs(headers),
        q.first("game"),
        q.first("marketplaceGame"),
    )
}
async fn auth(state: &DomainState, headers: &HeaderMap) -> Result<crate::Claims, ApiError> {
    let token = crate::auth::bearer(headers.get("authorization").and_then(|h| h.to_str().ok()))
        .map_err(ApiError::from)?;
    state.verifier().verify(token).await.map_err(ApiError::from)
}
fn response(result: Result<Value, ApiError>, private: bool) -> Response {
    match result {
        Ok(v) => {
            if private {
                private_json(v)
            } else {
                Json(v).into_response()
            }
        }
        Err(e) => {
            let mut v = json!({"error":e.message});
            if e.code.as_deref() == Some("insufficient_quantity") {
                v["code"] = json!("insufficient_quantity");
            }
            (e.status, Json(v)).into_response()
        }
    }
}
async fn card_ids_in_catalog(
    state: &DomainState,
    ids: &[String],
    game: &str,
) -> Result<Option<Vec<String>>, ApiError> {
    // card_id is bigint: compare as bigint so the primary key serves the
    // lookup (a text cast scanned the whole catalog on every MyPokoin load).
    let numeric: Vec<i64> = ids.iter().filter_map(|id| id.trim().parse().ok()).collect();
    if numeric.is_empty() {
        return Ok(Some(vec![]));
    }
    let Some(pools) = state.game_pools(game).await else {
        return Err(DomainState::game_catalog_unconfigured(game));
    };
    let rows=sqlx::query_scalar::<_,String>("select card_id::text as card_id from public.marketplace_search_candidates where card_id = any($1::bigint[])").bind(&numeric).fetch_all(&pools.read).await;
    match rows {
        Ok(ids) => Ok(Some(ids)),
        Err(e)
            if e.as_database_error().and_then(|d| d.code()).as_deref() == Some("42P01")
                || e.to_string().contains("does not exist") =>
        {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}
async fn seller_card_ids(
    state: &DomainState,
    seller: &str,
    game: &str,
) -> Result<Option<Vec<String>>, ApiError> {
    let ids=sqlx::query_scalar::<_,String>("select distinct card_id from public.marketplace_user_listings where seller_uid = $1 and nullif(card_id, '') is not null").bind(seller).fetch_all(state.read_db()).await?;
    card_ids_in_catalog(state, &ids, game).await
}
fn read_sql(
    query: &HashMap<String, String>,
    seller: &str,
    game: &str,
    catalog: Option<&[String]>,
) -> (String, Vec<Value>) {
    let mut values = vec![];
    let mut clauses = vec![];
    let card = clean_text(query.get("cardId").map(String::as_str).unwrap_or(""), 80);
    let id = clean_listing_id(query.get("id").map(String::as_str).unwrap_or(""));
    let own = query
        .get("sellerUid")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    for (column, value) in [
        ("card_id", card.as_str()),
        ("id", id.as_str()),
        ("seller_uid", seller),
    ] {
        if !value.is_empty() {
            values.push(json!(value));
            clauses.push(format!(
                "listings.{column} = ${}{}",
                values.len(),
                if column == "id" { "::uuid" } else { "" }
            ));
        }
    }
    if !own {
        clauses.push("listings.status = 'active'".into());
        clauses.push("listings.quantity_available > 0".into());
    }
    if id.is_empty() && card.is_empty() {
        values.push(json!(game));
        let gp = values.len();
        if let Some(ids) = catalog {
            values.push(json!(ids));
            let cp = values.len();
            if game == "pokemon" {
                clauses.push(format!(
                    "coalesce(nullif(marketplace_game, ''), 'pokemon') = ${gp}"
                ));
                clauses.push(format!("listings.card_id = any(${cp}::text[])"));
            } else {
                clauses.push(format!("(coalesce(nullif(marketplace_game, ''), 'pokemon') = ${gp} or (coalesce(nullif(marketplace_game, ''), 'pokemon') = 'pokemon' and listings.card_id = any(${cp}::text[])))"));
            }
        } else {
            clauses.push(format!(
                "coalesce(nullif(marketplace_game, ''), 'pokemon') = ${gp}"
            ));
        }
    }
    values.push(json!(clean_limit(query.get("limit"))));
    let lp = values.len();
    let offset = clean_offset(query.get("offset"));
    let offset_sql = if offset > 0 {
        values.push(json!(offset));
        format!(" offset ${}", values.len())
    } else {
        String::new()
    };
    (format!("select to_jsonb(listings) as listing from public.marketplace_user_listings listings {} order by price_pkn asc, updated_at desc, created_at desc limit ${lp}{offset_sql}",if clauses.is_empty(){String::new()}else{format!("where {}",clauses.join(" and "))}),values)
}
pub async fn read_listings(
    state: &DomainState,
    query: &HashMap<String, String>,
    decoded: Option<&crate::Claims>,
    game: &str,
) -> Result<Vec<Value>, ApiError> {
    let raw_id = clean_text(query.get("id").map(String::as_str).unwrap_or(""), 80);
    if !raw_id.is_empty() && clean_listing_id(&raw_id).is_empty() {
        return Ok(vec![]);
    }
    let card = clean_text(query.get("cardId").map(String::as_str).unwrap_or(""), 80);
    let uid = clean_text(
        query.get("sellerUid").map(String::as_str).unwrap_or(""),
        160,
    );
    let username = clean_text(
        query
            .get("sellerUsername")
            .map(String::as_str)
            .unwrap_or(""),
        64,
    );
    if !uid.is_empty() && !username.is_empty() {
        return Err(ApiError::bad_request(
            "Use either sellerUid or sellerUsername, not both.",
        ));
    }
    let seller = if !uid.is_empty() {
        if decoded.map(|d| d.uid.as_str()) != Some(uid.as_str()) {
            return Err(ApiError::forbidden(
                "You can only read your own seller listings.",
            ));
        }
        uid.clone()
    } else if !username.is_empty() {
        live::field(
            &live::seller_profile(state, &username, true).await?,
            "uid",
            160,
        )
    } else {
        String::new()
    };
    let catalog = if raw_id.is_empty() && card.is_empty() && !seller.is_empty() {
        seller_card_ids(state, &seller, game).await?
    } else {
        None
    };
    let (sql, values) = read_sql(query, &seller, game, catalog.as_deref());
    let mut builder = sqlx::query(&sql);
    for v in &values {
        builder = bind_json(builder, v);
    }
    let rows = builder.fetch_all(state.read_db()).await?;
    let mut rows: Vec<Value> = rows
        .into_iter()
        .map(|r| r.try_get("listing"))
        .collect::<Result<_, _>>()?;
    if uid.is_empty() && username.is_empty() {
        live::enrich_sellers(state, &mut rows).await;
    }
    live::enrich_urls(state, &mut rows).await;
    let mut listings: Vec<Value> = rows
        .iter()
        .map(|r| live::listing_row(r, !uid.is_empty()))
        .collect();
    if !card.is_empty()
        && uid.is_empty()
        && username.is_empty()
        && query.get("nativeOnly").map(String::as_str) != Some("1")
        && query.get("live").map(String::as_str) != Some("0")
    {
        listings
            .extend(live::live_offers(state, &card, clean_limit(query.get("limit")), game).await);
        listings
            .sort_by(|a, b| live::number(&a["pricePkn"]).total_cmp(&live::number(&b["pricePkn"])));
    }
    Ok(listings)
}
pub async fn marketplace_listings_get(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let q = query_map(&uri);
    let game = request_game(&headers, &uri);
    let result = async {
        if q.get("sellerUid")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
            && q.get("sellerUsername")
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        {
            return Err(ApiError::bad_request(
                "Use either sellerUid or sellerUsername, not both.",
            ));
        }
        let decoded = if q
            .get("sellerUid")
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            Some(auth(&state, &headers).await?)
        } else {
            None
        };
        Ok(json!({"listings":read_listings(&state,&q,decoded.as_ref(),&game).await?}))
    }
    .await;
    response(result, true)
}
fn parse_body(headers: &HeaderMap, body: &Bytes) -> Result<Value, ApiError> {
    http::parse_body(headers, body)
        .map(|b| b.json().clone())
        .map_err(|_| ApiError::bad_request("Invalid JSON body."))
}
pub async fn marketplace_listings_post(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let result = async {
        let claims = auth(&state, &headers).await?;
        let body = parse_body(&headers, &body)?;
        let q = query_map(&uri);
        let id = clean_listing_id(q.get("id").map(String::as_str).unwrap_or(""));
        if q.get("action").map(String::as_str) == Some("decrement") && !id.is_empty() {
            let qty = live::number(&body["quantity"]);
            if !qty.is_finite() || qty.fract() != 0.0 || qty <= 0.0 || qty > 9_007_199_254_740_991.0
            {
                return Err(ApiError::bad_request(
                    "Quantity must be a positive integer.",
                ));
            }
            return decrement_listing(&state, &id, &claims.uid, qty as i64).await;
        }
        create_listing(&state, &claims, &body, &request_game(&headers, &uri)).await
    }
    .await;
    response(result, false)
}
fn role_entries(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a
            .iter()
            .map(|v| live::text(v, 240).to_lowercase())
            .filter(|s| !s.is_empty())
            .collect(),
        Value::String(s) => s
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect(),
        Value::Object(o) => o
            .iter()
            .filter(|(_, v)| **v == true)
            .map(|(k, _)| k.trim().to_lowercase())
            .collect(),
        _ => vec![],
    }
}
pub fn has_reserve_access(v: &Value) -> bool {
    for parent in [v, &v["customClaims"], &v["claims"]] {
        if ["reserve", "isReserve", "hasReserveAccess"]
            .iter()
            .any(|key| parent[*key] == true)
            || role_entries(&parent["roles"]).contains(&"reserve".to_string())
        {
            return true;
        }
    }
    live::field(v, "role", 40).eq_ignore_ascii_case("reserve")
}
async fn require_reserve(state: &DomainState, claims: &crate::Claims) -> Result<(), ApiError> {
    if has_reserve_access(&serde_json::to_value(claims).unwrap_or(Value::Null)) {
        return Ok(());
    }
    let lookup=async{let fs=state.firestore()?;let account=crate::ServiceAccount::from_env()?;let assertion=jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),&json!({"iss":account.client_email,"scope":"https://www.googleapis.com/auth/cloud-platform","aud":"https://oauth2.googleapis.com/token","iat":state.now_ms()/1000,"exp":state.now_ms()/1000+3600}),&jsonwebtoken::EncodingKey::from_rsa_pem(account.private_key_pem.as_bytes()).map_err(|_|ApiError::forbidden("Reserve listing access required."))?).map_err(|_|ApiError::forbidden("Reserve listing access required."))?;let oauth:Value=state.http().post("https://oauth2.googleapis.com/token").form(&[("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer"),("assertion",assertion.as_str())]).send().await.map_err(|_|ApiError::forbidden("Reserve listing access required."))?.json().await.map_err(|_|ApiError::forbidden("Reserve listing access required."))?;let token=live::field(&oauth,"access_token",8192);let reply=state.http().post(format!("https://identitytoolkit.googleapis.com/v1/projects/{}/accounts:lookup",fs.project_id())).bearer_auth(token).json(&json!({"localId":[claims.uid]})).send().await.map_err(|_|ApiError::forbidden("Reserve listing access required."))?;let data:Value=reply.json().await.map_err(|_|ApiError::forbidden("Reserve listing access required."))?;let attrs=data.pointer("/users/0/customAttributes").and_then(Value::as_str).unwrap_or("{}");Ok::<bool,ApiError>(has_reserve_access(&serde_json::from_str::<Value>(attrs).unwrap_or(Value::Null)))}.await;
    if lookup.unwrap_or(false) {
        Ok(())
    } else {
        Err(ApiError::forbidden("Reserve listing access required."))
    }
}
fn collection_signature(value: &Value, name: &str, set: &str, num: &str) -> String {
    let compact = |key: &str, max| {
        live::field(value, key, max)
            .to_lowercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
    };
    let a = compact(name, 240);
    let b = compact(set, 240);
    let c = compact(num, 80);
    if a.is_empty() || b.is_empty() || c.is_empty() {
        String::new()
    } else {
        format!("{a}|{b}|{c}")
    }
}
async fn verify_nft(
    state: &DomainState,
    uid: &str,
    body: &Value,
    qty: i64,
    reserve: bool,
) -> Result<(), ApiError> {
    if body["nftAvailable"] != true || reserve {
        return Ok(());
    }
    if !live::field(body, "source", 80).eq_ignore_ascii_case("pokoin_user_nft") {
        return Err(ApiError::forbidden("NFT listings must use an owned NFT."));
    }
    if qty != 1 {
        return Err(ApiError::bad_request(
            "NFT listings are limited to one owned NFT.",
        ));
    }
    let item = live::field(body, "sourceListingId", 160);
    if item.is_empty() {
        return Err(ApiError::bad_request(
            "NFT listing requires an owned NFT id.",
        ));
    }
    let fs = state.firestore()?;
    let doc = fs
        .get_document(&fs.document_path("user_card_collections", &item))
        .await?;
    let data = doc.clone().unwrap_or_else(|| json!({}));
    let owned = live::first(&data, &["cardId", "blueprintId"], 80);
    let requested = live::field(body, "cardId", 80);
    let sig = collection_signature(&data, "cardName", "setName", "collectorNumber");
    let reqsig = collection_signature(body, "cardName", "setName", "collectorNumber");
    let nft = live::field(&data, "ownershipType", 40).eq_ignore_ascii_case("nft")
        || live::field(&data, "fulfillmentMode", 40).eq_ignore_ascii_case("nft_only")
        || live::field(&data, "nftStatus", 40).eq_ignore_ascii_case("owned");
    if doc.is_none()
        || data["uid"] != uid
        || !nft
        || !((!owned.is_empty() && owned == requested) || (!sig.is_empty() && sig == reqsig))
    {
        return Err(ApiError::forbidden(
            "You can only list NFTs you own for this card.",
        ));
    }
    Ok(())
}
async fn metadata(state: &DomainState, card: &str) -> Value {
    sqlx::query_scalar::<_,Value>("select to_jsonb(v) from (select name, image_url, expansion_name, expansion_number from public.marketplace_card_versions where card_id = $1 limit 1) v").bind(card).fetch_optional(state.read_db()).await.ok().flatten().unwrap_or_else(||json!({}))
}
async fn finish_write(
    state: &DomainState,
    row: &Value,
    queued: bool,
    game: &str,
    seller: &str,
) -> Result<Value, ApiError> {
    let mut rows = vec![row.clone()];
    live::enrich_sellers(state, &mut rows).await;
    let listing = live::listing_row(&rows[0], true);
    sync::invalidate(state, game, &live::field(&listing, "cardId", 80), seller).await;
    if queued {
        sync::kick(state);
    } else {
        sync::refresh_price(state, &live::field(&listing, "cardId", 80)).await?;
    }
    Ok(listing)
}
fn ct_listing(row: &Value) -> Value {
    let mut v = json!({});
    for (dest, src) in [
        ("id", "id"),
        ("cardId", "card_id"),
        ("pricePkn", "price_pkn"),
        ("quantityAvailable", "quantity_available"),
        ("condition", "condition"),
        ("language", "language"),
        ("signed", "signed"),
        ("reverse", "reverse"),
        ("firstEdition", "first_edition"),
        ("foilState", "foil_state"),
        ("graded", "graded"),
        ("altered", "altered"),
        ("sellerComment", "seller_comment"),
    ] {
        v[dest] = row[src].clone();
    }
    v
}
fn create_values(
    body: &Value,
    uid: &str,
    game: &str,
    meta: &Value,
) -> Result<Vec<Value>, ApiError> {
    let card = live::field(body, "cardId", 80);
    let country = live::first(body, &["sellerCountry", "shipFromCountry"], 40).to_uppercase();
    if country.is_empty() || country == "EU" {
        return Err(ApiError::bad_request(
            "shipFromCountry (ISO country code) is required before listing.",
        ));
    }
    if country.len() != 2 || !country.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(ApiError::bad_request(
            "shipFromCountry must be an ISO 3166-1 alpha-2 code.",
        ));
    }
    let txt = |key, max, default: &str| {
        let v = live::field(body, key, max);
        json!(if v.is_empty() { default.to_string() } else { v })
    };
    let opt = |key, max| {
        let v = live::field(body, key, max);
        if v.is_empty() {
            Value::Null
        } else {
            json!(v)
        }
    };
    let info = |key, mkey, max, fallback: &str| {
        let mut v = live::field(body, key, max);
        if v.is_empty() {
            v = live::field(meta, mkey, max);
        }
        if v.is_empty() {
            v = fallback.to_string();
        }
        json!(v)
    };
    Ok(vec![
        json!(card),
        json!(uid),
        txt("sellerName", 120, "Pokoin seller"),
        json!(country),
        txt("sellerReputationLabel", 40, "New"),
        txt("condition", 20, "NM"),
        txt("language", 10, "EN"),
        json!(live::number(&body["pricePkn"])),
        json!(live::number(&body["quantityAvailable"]) as i64),
        json!(body["signed"] == true),
        json!(body["reverse"] == true),
        json!(body["firstEdition"] == true),
        txt(
            "foilState",
            40,
            if body["reverse"] == true {
                "reverse"
            } else {
                "standard"
            },
        ),
        txt("variantState", 80, ""),
        json!(body["sealed"] == true),
        json!(body["graded"] == true),
        opt("gradingCompany", 80),
        opt("grade", 40),
        opt("certificationId", 120),
        json!(body["shippingAvailable"] != false),
        json!(live::reserve_body(body)),
        json!(body["nftAvailable"] == true),
        txt("sellerComment", 500, ""),
        txt("source", 80, "pokoin_user_listing"),
        txt("sourceListingId", 160, ""),
        info("cardName", "name", 240, &card),
        info("cardImageUrl", "image_url", 800, ""),
        info("setName", "expansion_name", 240, "Pokemon"),
        info("collectorNumber", "expansion_number", 80, &card),
        txt("location", 64, ""),
        json!(body["altered"] == true),
        json!(game),
    ])
}
const CREATE_SQL:&str="insert into public.marketplace_user_listings (card_id, seller_uid, seller_name, seller_country, seller_reputation_label, condition, language, price_pkn, quantity_available, signed, reverse, first_edition, foil_state, variant_state, sealed, graded, grading_company, grade, certification_id, shipping_available, reserve_available, nft_available, seller_comment, source, source_listing_id, card_name, card_image_url, set_name, collector_number, location, altered, marketplace_game) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) returning *";
async fn create_listing(
    state: &DomainState,
    claims: &crate::Claims,
    body: &Value,
    requested_game: &str,
) -> Result<Value, ApiError> {
    let card = live::field(body, "cardId", 80);
    let price = live::number(&body["pricePkn"]);
    let qty = live::number(&body["quantityAvailable"]);
    if card.is_empty() {
        return Err(ApiError::bad_request("Missing card id."));
    }
    if !price.is_finite() || price <= 0.0 {
        return Err(ApiError::bad_request("Enter a valid PKN price."));
    }
    if !qty.is_finite() || qty.fract() != 0.0 || !(1.0..=99.0).contains(&qty) {
        return Err(ApiError::bad_request("Quantity must be between 1 and 99."));
    }
    let reserve = live::reserve_body(body);
    if reserve {
        require_reserve(state, claims).await?;
    }
    let targets = sync::targets(&body["targets"]);
    let mut cardtrader = json!({"ok":true,"skipped":true,"reason":"not_requested"});
    if targets["pokoin"] == false && targets["cardtrader"] == true {
        let pushed = sync::push_listing(state, &claims.uid, body, false).await;
        let cardtrader = match pushed {
            Ok(p) => {
                json!({"ok":true,"productId":p["productId"],"sourceListingId":p["sourceListingId"]})
            }
            Err(e) => json!({"ok":false,"error":e.message}),
        };
        return Ok(json!({"listing":null,"cardtrader":cardtrader,"targets":targets}));
    }
    verify_nft(state, &claims.uid, body, qty as i64, reserve).await?;
    let meta = metadata(state, &card).await;
    let g = live::field(body, "marketplaceGame", 40);
    let game =
        pokoin_api_common::game::normalize_game(if g.is_empty() { requested_game } else { &g });
    let values = create_values(body, &claims.uid, &game, &meta)?;
    let sql =
        format!("with written as ({CREATE_SQL}) select to_jsonb(written) as listing from written");
    let mut tx = state.write_db().begin().await?;
    let mut builder = sqlx::query(&sql);
    for value in &values {
        builder = bind_json(builder, value);
    }
    let row = builder.fetch_one(&mut *tx).await?;
    let row: Value = row.try_get("listing")?;
    let event = sync::event(
        &row,
        &json!({"game":game,"sellerUid":claims.uid,"mutation":"LISTING_CREATED","wantsCardtrader":targets["cardtrader"],"cardtraderListing":if targets["cardtrader"]==true{ct_listing(&row)}else{Value::Null}}),
        state.now_ms(),
    );
    let queued = sync::enqueue(&mut tx, event).await?;
    tx.commit().await?;
    let mut listing = finish_write(state, &row, queued, &game, &claims.uid).await?;
    if targets["cardtrader"] == true {
        if queued {
            cardtrader = json!({"ok":true,"pending":true});
        } else {
            match sync::push_listing(state, &claims.uid, &ct_listing(&row), true).await {
                Ok(p) => {
                    cardtrader = json!({"ok":true,"productId":p["productId"],"sourceListingId":p["sourceListingId"]});
                    listing["sourceListingId"] = p["sourceListingId"].clone();
                }
                Err(e) => cardtrader = json!({"ok":false,"error":e.message}),
            }
        }
    }
    listing["cardtrader"] = cardtrader;
    listing["targets"] = targets;
    Ok(listing)
}
async fn decrement_listing(
    state: &DomainState,
    id: &str,
    seller: &str,
    qty: i64,
) -> Result<Value, ApiError> {
    let mut tx = state.write_db().begin().await?;
    let row = sqlx::query(crate::handlers::orders::DECREMENT_SQL)
        .bind(uuid::Uuid::parse_str(id).map_err(|_| ApiError::bad_request("Listing id invalid."))?)
        .bind(seller)
        .bind(qty)
        .fetch_one(&mut *tx)
        .await?;
    let outcome: String = row.try_get("outcome")?;
    let listing: Option<Value> = row.try_get("listing")?;
    if outcome != "updated" {
        tx.commit().await?;
        return match outcome.as_str() {
            "invalid" => Err(ApiError::bad_request(
                "Quantity must be a positive integer.",
            )),
            "insufficient" => {
                Err(ApiError::conflict("Not enough quantity.").with_code("insufficient_quantity"))
            }
            _ => Err(ApiError::not_found("Listing not found for this seller.")),
        };
    }
    let row = listing.ok_or_else(|| ApiError::internal("Marketplace listings failed."))?;
    let sold = row["status"] == "sold_out" || live::number(&row["quantity_available"]) <= 0.0;
    let queued=sync::enqueue(&mut tx,sync::event(&row,&json!({"sellerUid":seller,"mutation":if sold{"LISTING_SOLD"}else{"LISTING_QUANTITY_CHANGED"}}),state.now_ms())).await?;
    tx.commit().await?;
    let game = live::first(&row, &["marketplace_game"], 40);
    let game = if game.is_empty() { "pokemon" } else { &game };
    Ok(json!({"listing":finish_write(state,&row,queued,game,seller).await?}))
}
fn update_values(id: &str, uid: &str, body: &Value) -> Result<(Vec<String>, Vec<Value>), ApiError> {
    let mut sets = vec!["updated_at = now()".into()];
    let mut values = vec![json!(id)];
    let mut push = |column: &str, v: Value| {
        values.push(v);
        sets.push(format!("{column} = ${}", values.len()));
    };
    let status = live::field(body, "status", 20);
    if !status.is_empty() {
        push("status", json!(status));
    }
    if body.get("quantityAvailable").is_some() {
        let q = live::number(&body["quantityAvailable"]);
        if !q.is_finite() || q.fract() != 0.0 || !(0.0..=99.0).contains(&q) {
            return Err(ApiError::bad_request("Quantity must be between 0 and 99."));
        }
        push("quantity_available", json!(q as i64));
    }
    if body.get("pricePkn").is_some() {
        let p = live::number(&body["pricePkn"]);
        if !p.is_finite() || p <= 0.0 {
            return Err(ApiError::bad_request("Enter a valid PKN price."));
        }
        push("price_pkn", json!(p));
    }
    for (key, col, max, fallback) in [
        ("condition", "condition", 20, Some("NM")),
        ("language", "language", 10, Some("EN")),
        ("location", "location", 64, Some("")),
        ("foilState", "foil_state", 40, Some("standard")),
        ("variantState", "variant_state", 80, Some("")),
        ("gradingCompany", "grading_company", 80, None),
        ("grade", "grade", 40, None),
        ("certificationId", "certification_id", 120, None),
        ("sellerComment", "seller_comment", 500, Some("")),
        ("source", "source", 80, Some("pokoin_user_listing")),
        ("sourceListingId", "source_listing_id", 160, Some("")),
    ] {
        if body.get(key).is_some() {
            let s = live::field(body, key, max);
            push(
                col,
                if s.is_empty() {
                    fallback.map(|s| json!(s)).unwrap_or(Value::Null)
                } else {
                    json!(s)
                },
            );
        }
    }
    for (key, col) in [
        ("signed", "signed"),
        ("reverse", "reverse"),
        ("firstEdition", "first_edition"),
        ("altered", "altered"),
        ("sealed", "sealed"),
        ("graded", "graded"),
        ("reserveAvailable", "reserve_available"),
        ("nftAvailable", "nft_available"),
        ("shippingAvailable", "shipping_available"),
    ] {
        if body.get(key).is_some() {
            push(
                col,
                json!(if key == "shippingAvailable" {
                    body[key] != false
                } else {
                    body[key] == true
                }),
            );
        }
    }
    for (key, col, max) in [
        ("cardName", "card_name", 240),
        ("cardImageUrl", "card_image_url", 800),
        ("setName", "set_name", 240),
        ("collectorNumber", "collector_number", 80),
    ] {
        if body.get(key).is_some() {
            let s = live::field(body, key, max);
            if !s.is_empty() {
                push(col, json!(s));
            }
        }
    }
    if status.is_empty()
        && body.get("quantityAvailable").is_some()
        && live::number(&body["quantityAvailable"]) == 0.0
    {
        sets.push("status = 'paused'".into());
    }
    values.push(json!(uid));
    Ok((sets, values))
}
pub async fn marketplace_listings_patch(
    State(state): State<DomainState>,
    headers: HeaderMap,
    uri: Uri,
    bytes: Bytes,
) -> Response {
    let result = async {
        let claims = auth(&state, &headers).await?;
        let q = query_map(&uri);
        let id = clean_listing_id(q.get("id").map(String::as_str).unwrap_or(""));
        if id.is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::METHOD_NOT_ALLOWED,
                "Method not allowed.",
            ));
        }
        let body = parse_body(&headers, &bytes)?;
        update_listing(&state, &claims, &id, &body).await
    }
    .await;
    let mut out = response(result, false);
    if out.status() == axum::http::StatusCode::METHOD_NOT_ALLOWED {
        out.headers_mut().insert(
            "allow",
            axum::http::HeaderValue::from_static("GET, POST, PATCH"),
        );
    }
    out
}
async fn update_listing(
    state: &DomainState,
    claims: &crate::Claims,
    id: &str,
    body: &Value,
) -> Result<Value, ApiError> {
    let uuid = uuid::Uuid::parse_str(id)
        .map_err(|_| ApiError::not_found("Listing not found for this seller."))?;
    let existing=sqlx::query_scalar::<_,Value>("select to_jsonb(v) from (select seller_uid, card_id, quantity_available, reserve_available, source, source_listing_id from public.marketplace_user_listings where id = $1 limit 1) v").bind(uuid).fetch_optional(state.read_db()).await?.ok_or_else(||ApiError::not_found("Listing not found for this seller."))?;
    if existing["seller_uid"] != claims.uid {
        return Err(ApiError::not_found("Listing not found for this seller."));
    }
    let (sets, values) = update_values(id, &claims.uid, body)?;
    if live::reserve_row(&existing) || live::reserve_body(body) {
        require_reserve(state, claims).await?;
    }
    if body["nftAvailable"] == true && !live::reserve_row(&existing) {
        let mut b = body.clone();
        for (key, src) in [
            ("cardId", "card_id"),
            ("source", "source"),
            ("sourceListingId", "source_listing_id"),
        ] {
            if !b.get(key).map(live::js_truthy).unwrap_or(false) {
                b[key] = existing[src].clone();
            }
        }
        let qty = body
            .get("quantityAvailable")
            .map(live::number)
            .unwrap_or_else(|| live::number(&existing["quantity_available"]));
        verify_nft(state, &claims.uid, &b, qty as i64, false).await?;
    }
    let status = live::field(body, "status", 20);
    let inactive = status == "inactive"
        || status == "sold_out"
        || (body.get("quantityAvailable").is_some()
            && live::number(&body["quantityAvailable"]) == 0.0);
    let sql=format!("with written as (update public.marketplace_user_listings set {} where id = $1::uuid and seller_uid = ${} returning *) select to_jsonb(written) as listing from written",sets.join(", "),values.len());
    let mut tx = state.write_db().begin().await?;
    // The CardTrader product this listing is linked to right now, read on the
    // writer under the row lock. `existing` comes from the replica and can
    // predate the push that linked it: the product then outlived the listing
    // (specs/tla/listing-outbox NoGhostProduct).
    let source = sqlx::query_scalar::<_, String>(
        "select source_listing_id from public.marketplace_user_listings where id = $1 and seller_uid = $2 for update",
    )
    .bind(uuid)
    .bind(&claims.uid)
    .fetch_optional(&mut *tx)
    .await?
    .map(|s| s.trim().chars().take(160).collect::<String>())
    .unwrap_or_default();
    let mut builder = sqlx::query(&sql);
    for value in &values {
        builder = bind_json(builder, value);
    }
    let row = builder
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("Listing not found for this seller."))?;
    let row: Value = row.try_get("listing")?;
    let queued=sync::enqueue(&mut tx,sync::event(&row,&json!({"sellerUid":claims.uid,"mutation":sync::mutation(&existing,body,&status),"destroyCardtrader":inactive&&!source.is_empty(),"sourceListingId":source}),state.now_ms())).await?;
    tx.commit().await?;
    let game = live::field(&row, "marketplace_game", 40);
    let listing = finish_write(
        state,
        &row,
        queued,
        if game.is_empty() { "pokemon" } else { &game },
        &claims.uid,
    )
    .await?;
    if !queued && inactive && !source.is_empty() {
        let _ = sync::destroy_product(
            state,
            &claims.uid,
            &source,
            live::number(&existing["quantity_available"]),
        )
        .await;
    }
    Ok(listing)
}
pub async fn marketplace_listings_other(
    State(state): State<DomainState>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = auth(&state, &headers).await {
        return response(Err(e), false);
    }
    method_not_allowed("GET, POST, PATCH")
}

// ---------------------------------------------------------------------------
// CSV export / import
// ---------------------------------------------------------------------------

struct SellerListing {
    id: String,
    card_id: String,
    card_name: String,
    set_name: String,
    collector_number: String,
    condition: String,
    language: String,
    price_pkn: f64,
    quantity: i64,
    signed: bool,
    reverse: bool,
    first_edition: bool,
    foil_state: String,
    variant_state: String,
    altered: bool,
    seller_comment: String,
    location: String,
    source: String,
}

impl SellerListing {
    fn to_export_json(&self) -> Value {
        json!({
            "id": self.id,
            "cardId": self.card_id,
            "cardName": self.card_name,
            "setName": self.set_name,
            "collectorNumber": self.collector_number,
            "condition": self.condition,
            "language": self.language,
            "pricePkn": self.price_pkn,
            "quantityAvailable": self.quantity,
            "signed": self.signed,
            "reverse": self.reverse,
            "firstEdition": self.first_edition,
            "foilState": self.foil_state,
            "variantState": self.variant_state,
            "altered": self.altered,
            "sellerComment": self.seller_comment,
            "location": self.location,
            "source": self.source,
            "sourceListingId": self.source,
            "blueprintId": self.card_id,
            "cardmarketId": "",
        })
    }
}

async fn load_seller_listings(
    state: &DomainState,
    uid: &str,
) -> Result<Vec<SellerListing>, ApiError> {
    let rows = sqlx::query(
        "select * from public.marketplace_user_listings
          where seller_uid = $1 and status in ('active', 'paused', 'inactive')
          order by updated_at desc limit 10000",
    )
    .bind(uid)
    .fetch_all(state.read_db())
    .await?;
    Ok(rows
        .iter()
        .map(|row| SellerListing {
            id: row
                .try_get::<uuid::Uuid, _>("id")
                .map(|id| id.to_string())
                .unwrap_or_default(),
            card_id: row.try_get("card_id").unwrap_or_default(),
            card_name: row
                .try_get::<Option<String>, _>("card_name")
                .ok()
                .flatten()
                .unwrap_or_default(),
            set_name: row
                .try_get::<Option<String>, _>("set_name")
                .ok()
                .flatten()
                .unwrap_or_default(),
            collector_number: row
                .try_get::<Option<String>, _>("collector_number")
                .ok()
                .flatten()
                .unwrap_or_default(),
            condition: row
                .try_get::<Option<String>, _>("condition")
                .ok()
                .flatten()
                .unwrap_or_default(),
            language: row
                .try_get::<Option<String>, _>("language")
                .ok()
                .flatten()
                .unwrap_or_default(),
            price_pkn: row.try_get::<f64, _>("price_pkn").unwrap_or(0.0),
            quantity: row.try_get::<i32, _>("quantity_available").unwrap_or(0) as i64,
            signed: row
                .try_get::<Option<bool>, _>("signed")
                .ok()
                .flatten()
                .unwrap_or(false),
            reverse: row
                .try_get::<Option<bool>, _>("reverse")
                .ok()
                .flatten()
                .unwrap_or(false),
            first_edition: row
                .try_get::<Option<bool>, _>("first_edition")
                .ok()
                .flatten()
                .unwrap_or(false),
            foil_state: row
                .try_get::<Option<String>, _>("foil_state")
                .ok()
                .flatten()
                .unwrap_or_else(|| "standard".into()),
            variant_state: row
                .try_get::<Option<String>, _>("variant_state")
                .ok()
                .flatten()
                .unwrap_or_default(),
            altered: row
                .try_get::<Option<bool>, _>("altered")
                .ok()
                .flatten()
                .unwrap_or(false),
            seller_comment: row
                .try_get::<Option<String>, _>("seller_comment")
                .ok()
                .flatten()
                .unwrap_or_default(),
            location: row
                .try_get::<Option<String>, _>("location")
                .ok()
                .flatten()
                .unwrap_or_default(),
            source: row
                .try_get::<Option<String>, _>("source")
                .ok()
                .flatten()
                .unwrap_or_default(),
        })
        .collect())
}

pub async fn marketplace_listings_csv_get(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let format = query
        .get("format")
        .map(|value| clean_text(value, 40))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "powertools".into());
    if !stock_csv::FORMATS.contains(&format.as_str()) {
        return Err(ApiError::bad_request(
            "format must be powertools, cardmarket, cardtrader, or tcgplayer.",
        ));
    }
    let listings = load_seller_listings(&state, &claims.uid).await?;
    let rows: Vec<Value> = listings.iter().map(|row| row.to_export_json()).collect();
    let body = stock_csv::export_listings_csv(&format, &rows)
        .map_err(|message| ApiError::bad_request(message))?;
    let mut response = body.into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    if let Ok(value) = axum::http::HeaderValue::from_str(&format!(
        "attachment; filename=\"pokoin-stock-{format}.csv\""
    )) {
        response
            .headers_mut()
            .insert(axum::http::header::CONTENT_DISPOSITION, value);
    }
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("private, no-store"),
    );
    Ok(response)
}

pub async fn marketplace_listings_csv_post(
    State(state): State<DomainState>,
    AuthedUser(claims): AuthedUser,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let csv_text = body.get("csv").and_then(Value::as_str).unwrap_or_default();
    if csv_text.trim().is_empty() {
        return Err(ApiError::bad_request("Missing csv text."));
    }
    let stack_size = body
        .get("stackSize")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| (value.trunc() as i64).max(1))
        .unwrap_or(1);
    let price_mode = match clean_text(
        body.get("priceMode")
            .and_then(Value::as_str)
            .unwrap_or("eur_to_pkn"),
        40,
    )
    .as_str()
    {
        "as_pkn" => PriceMode::AsPkn,
        "cents_eur_to_pkn" => PriceMode::CentsEurToPkn,
        _ => PriceMode::EurToPkn,
    };
    let dry_run = body.get("dryRun").and_then(Value::as_bool) != Some(false);
    let format = body
        .get("format")
        .and_then(Value::as_str)
        .map(|value| clean_text(value, 40))
        .filter(|value| !value.is_empty());
    let preserve_location = body.get("preserveLocation").and_then(Value::as_bool) == Some(true);
    let cardtrader_intent = match body.get("cardtraderIntent").and_then(Value::as_str) {
        Some("link") => "link",
        Some("import") => "import",
        _ => "",
    };

    let options = ImportOptions {
        format,
        price_mode,
        preserve_location,
        stack_size: Some(stack_size),
        ..Default::default()
    };
    let parsed = stock_csv::import_csv_text(csv_text, &options)
        .map_err(|message| ApiError::bad_request(message))?;

    let mut created: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    let mut preview: Vec<Value> = Vec::new();

    for entry in &parsed.results {
        let raw_json = Value::Object(entry.raw.clone());
        if !entry.ok {
            failed.push(json!({
                "line": entry.index,
                "error": entry.error.clone().unwrap_or_else(|| "Invalid row".into()),
                "raw": raw_json,
            }));
            continue;
        }
        let Some(row) = entry.row.clone() else {
            continue;
        };
        let price = row.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
        if !(price > 0.0) {
            failed.push(json!({
                "line": entry.index,
                "error": "Invalid or missing price",
                "raw": raw_json,
                "row": row,
            }));
            continue;
        }
        let resolved = match resolve_card(&state, &row).await? {
            Ok(resolved) => resolved,
            Err(message) => {
                failed.push(json!({
                    "line": entry.index,
                    "error": message,
                    "raw": raw_json,
                    "row": row,
                }));
                continue;
            }
        };
        if dry_run {
            preview.push(json!({
                "line": entry.index,
                "cardId": resolved.card_id,
                "name": resolved.card_name,
                "location": row.get("location").cloned().unwrap_or(json!("")),
                "condition": row.get("condition").cloned().unwrap_or(json!("NM")),
                "language": row.get("language").cloned().unwrap_or(json!("EN")),
                "pricePkn": price,
                "quantity": row.get("quantity").cloned().unwrap_or(json!(1)),
            }));
            continue;
        }
        match insert_import_listing(
            &state,
            &claims.uid,
            &row,
            &resolved,
            &parsed.format,
            cardtrader_intent,
        )
        .await
        {
            Ok(InsertOutcome::Created { id, card_id, location }) => created.push(json!({
                "line": entry.index, "created": true, "id": id, "cardId": card_id, "location": location,
            })),
            Ok(InsertOutcome::Skipped { id, reason }) => skipped.push(json!({
                "line": entry.index, "skipped": true, "id": id, "reason": reason,
            })),
            Err(error) => failed.push(json!({
                "line": entry.index,
                "error": error.to_string(),
                "raw": raw_json,
                "row": row,
            })),
        }
    }

    let failed_csv = if failed.is_empty() {
        String::new()
    } else {
        let mut headers = stock_csv::headers_for(&parsed.format).unwrap_or_default();
        headers.push("importError".into());
        let rows: Vec<Value> = failed
            .iter()
            .map(|row| {
                let mut object = row.get("raw").cloned().unwrap_or(json!({}));
                if let Some(map) = object.as_object_mut() {
                    map.insert(
                        "importError".into(),
                        row.get("error").cloned().unwrap_or(json!("")),
                    );
                }
                object
            })
            .collect();
        stock_csv::to_csv(&headers, &rows)
    };

    Ok(private_json(json!({
        "format": parsed.format,
        "dryRun": dry_run,
        "stackSize": stack_size,
        "priceMode": match price_mode {
            PriceMode::AsPkn => "as_pkn",
            PriceMode::CentsEurToPkn => "cents_eur_to_pkn",
            PriceMode::EurToPkn => "eur_to_pkn",
        },
        "counts": {
            "total": parsed.results.len(),
            "preview": preview.len(),
            "created": created.len(),
            "skipped": skipped.len(),
            "failed": failed.len(),
        },
        "preview": preview,
        "created": created,
        "skipped": skipped,
        "failed": failed,
        "failedCsv": failed_csv,
    })))
}

enum InsertOutcome {
    Created {
        id: String,
        card_id: String,
        location: String,
    },
    Skipped {
        id: String,
        reason: &'static str,
    },
}

struct ResolvedCard {
    card_id: String,
    card_name: String,
    set_name: String,
    collector_number: String,
    image_url: String,
}

/// `resolveCard`: exact name + collector against `marketplace_cards`.
async fn resolve_card(
    state: &DomainState,
    row: &Value,
) -> Result<Result<ResolvedCard, String>, ApiError> {
    let name = clean_text(
        row.get("name").and_then(Value::as_str).unwrap_or_default(),
        240,
    );
    let cn = clean_text(
        row.get("collectorNumber")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        40,
    );
    let set_name = clean_text(
        row.get("setName")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        240,
    );
    if name.is_empty() {
        return Ok(Err("Missing card name".into()));
    }
    let cn_core = {
        let without_prefix = cn.rsplit("| ").next().unwrap_or(&cn).trim().to_string();
        without_prefix
            .split('/')
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let mut sql = String::from(
        "select card_id::text as card_id, name, set_name, card_number, image_url, cdn_image_url
           from public.marketplace_cards
          where name = $1
            and set_name not ilike '%Poké Ball%'
            and set_name not ilike '%Master Ball%'",
    );
    if !cn_core.is_empty() {
        sql.push_str(
            " and (card_number = $2 or card_number like $2 || '/%'
               or card_number like '%| ' || $2 or card_number like '%| ' || $2 || '/%')",
        );
    }
    if !set_name.is_empty() {
        sql.push_str(" order by case when set_name ilike $3 then 0 else 1 end, card_id");
    } else {
        sql.push_str(" order by card_id");
    }
    sql.push_str(" limit 5");

    let mut builder = sqlx::query(&sql).bind(&name);
    if !cn_core.is_empty() {
        builder = builder.bind(&cn_core);
    }
    if !set_name.is_empty() {
        builder = builder.bind(format!("%{set_name}%"));
    }
    let rows = builder.fetch_all(state.read_db()).await.unwrap_or_default();
    if rows.is_empty() {
        return Ok(Err(format!("No catalog match for {name} {cn}")
            .trim()
            .to_string()));
    }
    let mapping: Vec<ResolvedCard> = rows
        .iter()
        .map(|row| ResolvedCard {
            card_id: row.try_get("card_id").unwrap_or_default(),
            card_name: row
                .try_get::<Option<String>, _>("name")
                .ok()
                .flatten()
                .unwrap_or_default(),
            set_name: row
                .try_get::<Option<String>, _>("set_name")
                .ok()
                .flatten()
                .unwrap_or_default(),
            collector_number: row
                .try_get::<Option<String>, _>("card_number")
                .ok()
                .flatten()
                .unwrap_or_default(),
            image_url: {
                let cdn: Option<String> = row.try_get("cdn_image_url").ok().flatten();
                let image: Option<String> = row.try_get("image_url").ok().flatten();
                cdn.or(image).unwrap_or_default()
            },
        })
        .collect();

    if mapping.len() > 1 && !set_name.is_empty() {
        let narrowed: Vec<&ResolvedCard> = mapping
            .iter()
            .filter(|row| {
                row.set_name
                    .to_lowercase()
                    .contains(&set_name.to_lowercase())
            })
            .collect();
        if narrowed.len() == 1 {
            let hit = narrowed[0];
            return Ok(Ok(ResolvedCard {
                card_id: hit.card_id.clone(),
                card_name: hit.card_name.clone(),
                set_name: hit.set_name.clone(),
                collector_number: hit.collector_number.clone(),
                image_url: hit.image_url.clone(),
            }));
        }
    }
    if mapping.len() > 1 {
        let ids: Vec<&str> = mapping.iter().map(|row| row.card_id.as_str()).collect();
        return Ok(Err(format!(
            "Ambiguous match for {name} ({})",
            ids.join(", ")
        )));
    }
    let hit = mapping.into_iter().next().expect("non-empty");
    Ok(Ok(hit))
}

async fn insert_import_listing(
    state: &DomainState,
    uid: &str,
    row: &Value,
    resolved: &ResolvedCard,
    format: &str,
    cardtrader_intent: &str,
) -> Result<InsertOutcome, sqlx::Error> {
    let source = stock_csv::source_for_format(format, cardtrader_intent);
    let source_listing_id = stock_csv::source_listing_id_for(format, row);
    if !source_listing_id.is_empty() {
        let existing = sqlx::query_scalar::<_, uuid::Uuid>(
            "select id from public.marketplace_user_listings
              where seller_uid = $1 and source = $2 and source_listing_id = $3 limit 1",
        )
        .bind(uid)
        .bind(source)
        .bind(&source_listing_id)
        .fetch_optional(state.read_db())
        .await
        .unwrap_or(None);
        if let Some(id) = existing {
            return Ok(InsertOutcome::Skipped {
                id: id.to_string(),
                reason: "already_imported",
            });
        }
    }

    let quantity = row
        .get("quantity")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 99);
    let price = row.get("pricePkn").and_then(Value::as_f64).unwrap_or(0.0);
    let row_text = |key: &str, fallback: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };
    let result = sqlx::query(
        r#"
        insert into public.marketplace_user_listings (
          card_id, seller_uid, seller_name, seller_country, seller_reputation_label,
          condition, language, price_pkn, quantity_available, signed, reverse,
          first_edition, foil_state, variant_state, sealed, graded,
          grading_company, grade, certification_id, shipping_available,
          reserve_available, nft_available, seller_comment, source,
          source_listing_id, card_name, card_image_url, set_name, collector_number,
          location, altered
        ) values (
          $1,$2,$3,'EU','New',$4,$5,$6,$7,$8,$9,$10,$11,$12,false,false,
          null,null,null,true,false,false,$13,$14,$15,$16,$17,$18,$19,$20,$21
        ) returning id, card_id, location
        "#,
    )
    .bind(&resolved.card_id)
    .bind(uid)
    .bind("Pokoin seller")
    .bind(row_text("condition", "NM"))
    .bind(row_text("language", "EN"))
    .bind(price)
    .bind(quantity as i32)
    .bind(row.get("signed").and_then(Value::as_bool) == Some(true))
    .bind(row.get("reverse").and_then(Value::as_bool) == Some(true))
    .bind(row.get("firstEdition").and_then(Value::as_bool) == Some(true))
    .bind(row_text("foilState", "standard"))
    .bind(row_text("variantState", ""))
    .bind(row_text("sellerComment", ""))
    .bind(source)
    .bind(&source_listing_id)
    .bind({
        let name = if resolved.card_name.is_empty() {
            row_text("name", "")
        } else {
            resolved.card_name.clone()
        };
        name
    })
    .bind(&resolved.image_url)
    .bind(if resolved.set_name.is_empty() {
        row_text("setName", "Pokemon")
    } else {
        resolved.set_name.clone()
    })
    .bind(if resolved.collector_number.is_empty() {
        row_text("collectorNumber", &resolved.card_id)
    } else {
        resolved.collector_number.clone()
    })
    .bind(row_text("location", ""))
    .bind(row.get("altered").and_then(Value::as_bool) == Some(true))
    .fetch_one(state.write_db())
    .await?;

    Ok(InsertOutcome::Created {
        id: result
            .try_get::<uuid::Uuid, _>("id")
            .map(|id| id.to_string())
            .unwrap_or_default(),
        card_id: result.try_get("card_id").unwrap_or_default(),
        location: result
            .try_get::<Option<String>, _>("location")
            .ok()
            .flatten()
            .unwrap_or_default(),
    })
}

/// Public native offers for one card desk — the interface the native card-page
/// handler needs (the Node `readPublicOffersForCard`).
///
/// Uses the same native read, enrichment and live merge as the listings route.
pub async fn read_public_offers_for_card(
    state: &DomainState,
    card_id: &str,
    limit: i64,
    game: &str,
    native_only: bool,
) -> Result<Vec<Value>, ApiError> {
    let mut query = HashMap::from([
        ("cardId".into(), card_id.into()),
        ("limit".into(), limit.to_string()),
    ]);
    if native_only {
        query.insert("nativeOnly".into(), "1".into());
    }
    read_listings(
        state,
        &query,
        None,
        &pokoin_api_common::game::normalize_game(game),
    )
    .await
}

/// Shared method guard for the listings family.
pub fn method_not_allowed(allow: &str) -> Response {
    let mut response = (
        axum::http::StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({"error":"Method not allowed."})),
    )
        .into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(allow) {
        response.headers_mut().insert("allow", value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_limits_and_offsets_match_the_node_guards() {
        assert_eq!(clean_limit(None), 500);
        assert_eq!(clean_limit(Some(&"0".into())), 1);
        assert_eq!(clean_limit(Some(&"100000".into())), 1000);
        assert_eq!(clean_offset(Some(&"-2".into())), 0);
        assert_eq!(clean_offset(Some(&"99999".into())), 50_000);
    }

    #[test]
    fn listing_ids_must_be_uuids() {
        assert_eq!(
            clean_listing_id("2f1c9f7a-4a4f-4a0e-9f2f-7f5b1c2d3e4f"),
            "2f1c9f7a-4a4f-4a0e-9f2f-7f5b1c2d3e4f"
        );
        assert_eq!(clean_listing_id("not-a-uuid"), "");
        assert_eq!(clean_listing_id(""), "");
    }

    #[test]
    fn clean_text_trims_and_caps() {
        assert_eq!(clean_text("  abc  ", 2), "ab");
        assert_eq!(clean_text("", 10), "");
    }
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    use async_trait::async_trait;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use std::sync::Arc;
    use tower::ServiceExt;
    struct Accept;
    #[async_trait]
    impl crate::TokenVerifier for Accept {
        async fn verify(&self, _: &str) -> Result<crate::Claims, crate::auth::AuthError> {
            Ok(crate::Claims {
                uid: "u1".into(),
                ..Default::default()
            })
        }
    }
    fn state() -> DomainState {
        DomainState::lazy(
            crate::CommerceConfig::default(),
            "postgres://x@127.0.0.1:1/x",
            Arc::new(Accept),
            Arc::new(crate::FixedClock(1_000)),
        )
    }
    async fn call(method: &str, uri: &str, body: Value, bearer: bool) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if bearer {
            req = req.header("authorization", "Bearer test");
        }
        let res = crate::router(state())
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[tokio::test]
    async fn routes_use_native_validation_auth_and_node_method_contract() {
        let (status, body) = call(
            "GET",
            "/api/marketplace-listings?id=bad",
            Value::Null,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"listings":[]}));
        let (status, body) = call(
            "GET",
            "/api/marketplace-listings?sellerUid=u1",
            Value::Null,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, json!({"error":"Missing Pokoin bearer token."}));
        let (status, body) = call(
            "GET",
            "/api/marketplace-listings?sellerUid=u2",
            Value::Null,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body,
            json!({"error":"You can only read your own seller listings."})
        );
        let (status, _) = call(
            "GET",
            "/api/marketplace-listings?sellerUid=u1&sellerUsername=alice",
            Value::Null,
            false,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, body) = call("POST", "/api/marketplace-listings", json!({}), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error":"Missing card id."}));
        let (status, body) = call(
            "POST",
            "/api/marketplace-listings?action=decrement&id=2f1c9f7a-4a4f-4a0e-9f2f-7f5b1c2d3e4f",
            json!({"quantity":0}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            json!({"error":"Quantity must be a positive integer."})
        );
        let (status, body) = call("PATCH", "/api/marketplace-listings", json!({}), true).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, json!({"error":"Method not allowed."}));
        let (status, body) = call("DELETE", "/api/marketplace-listings", json!({}), true).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body, json!({"error":"Method not allowed."}));
    }
    #[test]
    fn read_plan_scopes_seller_inventory_with_catalog_intersection() {
        let q = HashMap::from([
            ("sellerUsername".into(), "alice".into()),
            ("limit".into(), "5".into()),
            ("offset".into(), "7".into()),
        ]);
        let ids = vec!["801170".to_string()];
        let (sql, values) = read_sql(&q, "u1", "riftbound", Some(&ids));
        assert!(sql.contains("or (coalesce(nullif(marketplace_game, ''), 'pokemon') = 'pokemon'"));
        assert!(sql.contains("listings.card_id = any($3::text[])"));
        assert_eq!(
            values,
            json!(["u1", "riftbound", ["801170"], 5, 7])
                .as_array()
                .unwrap()
                .clone()
        );
        let q = HashMap::from([("cardId".into(), "801170".into())]);
        let (sql, values) = read_sql(&q, "", "riftbound", None);
        assert!(!sql.contains("marketplace_game"));
        assert_eq!(values[0], "801170");
    }
    #[test]
    fn update_plan_has_node_defaults_and_zero_quantity_pause() {
        let(sets,values)=update_values("id","u1",&json!({"quantityAvailable":"0","condition":"","language":null,"shippingAvailable":"false","cardName":"","source":"","signed":1})).unwrap();
        assert!(sets.contains(&"status = 'paused'".into()));
        assert!(!sets.iter().any(|s| s.starts_with("card_name")));
        assert!(values.contains(&json!("NM")));
        assert!(values.contains(&json!("EN")));
        assert!(values.contains(&json!("pokoin_user_listing")));
        assert!(update_values("id", "u1", &json!({"quantityAvailable":100})).is_err());
        assert!(update_values("id", "u1", &json!({"pricePkn":"oops"})).is_err());
        assert_eq!(
            update_values("id", "u1", &json!({})).unwrap().0,
            vec!["updated_at = now()"]
        );
    }
    #[test]
    fn create_plan_retains_optional_grading_metadata_and_catalog_fallback() {
        let v=create_values(&json!({"cardId":"22","sellerCountry":"de","pricePkn":"200","quantityAvailable":"1","gradingCompany":"PSA","grade":"10","certificationId":"abc"}),"u1","pokemon",&json!({"name":"Espurr","image_url":"image","expansion_name":"Set","expansion_number":"1/99"})).unwrap();
        assert_eq!(v.len(), 32);
        assert_eq!(v[3], "DE");
        assert_eq!(v[16], "PSA");
        assert_eq!(v[17], "10");
        assert_eq!(v[18], "abc");
        assert_eq!(v[25], "Espurr");
        assert_eq!(v[28], "1/99");
        assert!(
            create_values(&json!({"sellerCountry":"EU"}), "u1", "pokemon", &json!({})).is_err()
        );
        assert!(create_values(
            &json!({"sellerCountry":"Germany"}),
            "u1",
            "pokemon",
            &json!({})
        )
        .is_err());
    }
    #[test]
    fn reserve_claim_predicate_matches_all_node_forms() {
        for v in [
            json!({"reserve":true}),
            json!({"customClaims":{"hasReserveAccess":true}}),
            json!({"claims":{"roles":{"reserve":true}}}),
            json!({"roles":"seller, Reserve"}),
            json!({"roles":["reserve"]}),
            json!({"role":"reserve"}),
        ] {
            assert!(has_reserve_access(&v));
        }
        assert!(!has_reserve_access(&json!({"admin":true})));
        assert!(!has_reserve_access(
            &json!({"reserve":"true","roles":{"reserve":"true"}})
        ));
    }
    #[test]
    fn nft_signatures_ignore_punctuation_but_require_complete_identity() {
        assert_eq!(
            collection_signature(
                &json!({"n":"Mr. Mime","s":"Base Set","c":"64/102"}),
                "n",
                "s",
                "c"
            ),
            "mrmime|baseset|64102"
        );
        assert_eq!(
            collection_signature(&json!({"n":"Mr. Mime","s":"Base Set"}), "n", "s", "c"),
            ""
        );
    }
}
