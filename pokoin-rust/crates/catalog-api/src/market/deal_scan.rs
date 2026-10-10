//! `GET /api/cardtrader-deal-scan` — port of `cardtrader-deal-scan.js`
//! (facet-perfect sold comps vs a seller's live CardTrader listings).

use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use pokoin_api_common::pg::{self, Bind};
use pokoin_api_common::{http, RouteState};
use regex::Regex;
use serde_json::{json, Value};

use super::common::encode_uri_component;
use crate::shared::js;

const SOLD_WINDOW_DAYS: i64 = 90;
const MIN_SOLD_QTY: f64 = 3.0;
const CHEAP_SOLD_RATIO: f64 = 3.0;
const CHEAP_LIVE_RATIO: f64 = 2.0;
const EXPENSIVE_SOLD_RATIO: f64 = 4.0;
const EXPENSIVE_LIVE_RATIO: f64 = 3.0;
const MAX_DEALS_EACH: usize = 100;

static CONDITION_MAP: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)^(nm|near[ -]?mint|mint)$", "NM"),
        (r"(?i)^(sp|slightly[ -]?played|lightly[ -]?played)$", "SP"),
        (r"(?i)^(mp|played|moderately[ -]?played)$", "MP"),
        (r"(?i)^(pl|heavily[ -]?played|well[ -]?played|hp)$", "PL"),
        (r"(?i)^(poor|damaged)$", "Poor"),
    ]
    .into_iter()
    .map(|(p, c)| (Regex::new(p).unwrap(), c))
    .collect()
});

static LANGUAGE_MAP: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"(?i)^(en|english)$", "EN"),
        (r"(?i)^(it|italian)$", "IT"),
        (r"(?i)^(fr|french)$", "FR"),
        (r"(?i)^(de|german)$", "DE"),
        (r"(?i)^(es|spanish)$", "ES"),
        (r"(?i)^(jp|ja|japanese)$", "JP"),
        (r"(?i)^(pt|portuguese)$", "PT"),
        (r"(?i)^(nl|dutch)$", "NL"),
        (r"(?i)^(pl|polish)$", "PL"),
        (r"(?i)^(ru|russian)$", "RU"),
        (r"(?i)^(ko|kr|korean)$", "KO"),
        (r"(?i)^(zh|zh-cn|chinese)$", "ZH"),
        (r"(?i)^(zht|zh-tw)$", "ZHT"),
        (r"(?i)^(id|indonesian)$", "ID"),
    ]
    .into_iter()
    .map(|(p, c)| (Regex::new(p).unwrap(), c))
    .collect()
});

static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn clean_text(value: &str, max: usize) -> String {
    js::slice_utf16(WS.replace_all(value, " ").trim(), max)
}

fn normalize_condition(value: &str) -> &'static str {
    let text = clean_text(value, 60);
    if text.is_empty() {
        return "NM";
    }
    CONDITION_MAP.iter().find(|(re, _)| re.is_match(&text)).map(|(_, c)| *c).unwrap_or("NM")
}

fn normalize_language(value: &str) -> String {
    let text = clean_text(value, 40);
    if text.is_empty() {
        return "EN".into();
    }
    if let Some((_, code)) = LANGUAGE_MAP.iter().find(|(re, _)| re.is_match(&text)) {
        return (*code).into();
    }
    let upper = text.to_uppercase();
    const KNOWN: [&str; 14] = ["EN", "IT", "FR", "DE", "ES", "JP", "PT", "NL", "PL", "RU", "KO", "ZH", "ZHT", "ID"];
    if KNOWN.contains(&upper.as_str()) { upper } else { "EN".into() }
}

static PROFILE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)cardtrader\.com/(?:[a-z]{2}(?:-[A-Z]{2})?/)?users/([^/?#]+)").unwrap());
static HTTP_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^https?://").unwrap());
static USERNAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]{2,64}$").unwrap());

enum Seller {
    Ok(String),
    Bad(&'static str),
}

/// `parseSellerInput({ seller, url })`; `Err` is a malformed `%` escape (JS throws).
fn parse_seller_input(seller: Option<&str>, url: Option<&str>) -> Result<Seller, ()> {
    let source = url.filter(|u| !u.is_empty()).or(seller).unwrap_or("");
    let raw = clean_text(source, 300);
    if raw.is_empty() {
        return Ok(Seller::Bad("seller or url required"));
    }
    if let Some(caps) = PROFILE_URL.captures(&raw) {
        let decoded = urlencoding::decode(&caps[1]).map_err(|_| ())?;
        return Ok(Seller::Ok(decoded.into_owned()));
    }
    if HTTP_URL.is_match(&raw) {
        return Ok(Seller::Bad("url must be a CardTrader /users/{username} profile"));
    }
    let username = raw.strip_prefix('@').unwrap_or(&raw).trim_end_matches('/').to_owned();
    if !USERNAME.is_match(&username) {
        return Ok(Seller::Bad("invalid CardTrader username"));
    }
    Ok(Seller::Ok(username))
}

fn timing_safe_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn expected_token() -> String {
    std::env::var("DEAL_SCAN_TOKEN").unwrap_or_default().trim().to_owned()
}

static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^Bearer\s+(.+)$").unwrap());

fn is_authorized(headers: &HeaderMap) -> bool {
    let expected = expected_token();
    if expected.is_empty() {
        return false;
    }
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    match BEARER.captures(auth) {
        Some(caps) => timing_safe_equal(caps[1].trim(), &expected),
        None => false,
    }
}

struct Account {
    username: String,
    account_id: Value,
    snapshot_name: Value,
    listing_count: Value,
    quantity_sum: Value,
    resolved_via: &'static str,
    missing: bool,
}

const SELLER_BY_NAME: &str = "select seller_account_id::text as account_id,
            seller_account_name as snapshot_name,
            count(*)::int as listing_count,
            coalesce(sum(quantity), 0)::int as quantity_sum
       from cardtrader_market_listing_snapshots
      where seller_account_name = $1
      group by 1, 2
      order by listing_count desc
      limit 1";

const SELLER_BY_ID: &str = "select seller_account_id::text as account_id,
            seller_account_name as snapshot_name,
            count(*)::int as listing_count,
            coalesce(sum(quantity), 0)::int as quantity_sum
       from cardtrader_market_listing_snapshots
      where seller_account_id = $1
      group by 1, 2
      order by listing_count desc
      limit 1";

async fn fetch_card_trader_user_id(state: &RouteState, username: &str) -> Result<Option<String>, reqwest::Error> {
    let url = format!("https://www.cardtrader.com/en/users/{}.json", encode_uri_component(username));
    let response = state
        .api
        .http()
        .get(url)
        .header("Accept", "application/json")
        .header("User-Agent", "PokoinDealScan/1.0 (+https://pokoin.com)")
        .timeout(Duration::from_secs(12))
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let body: Value = response.json().await?;
    let id = [body.pointer("/user/id"), body.get("userId"), body.get("id")].into_iter().flatten().find(|v| !v.is_null());
    Ok(id.map(js::js_string))
}

async fn resolve_seller_account(state: &RouteState, username: &str) -> Result<Option<Account>, sqlx::Error> {
    let pool = state.api.read();
    let account = |row: &Value, via: &'static str| Account {
        username: username.to_owned(),
        account_id: row.get("account_id").cloned().unwrap_or(Value::Null),
        snapshot_name: row.get("snapshot_name").cloned().unwrap_or(Value::Null),
        listing_count: row.get("listing_count").cloned().unwrap_or(Value::Null),
        quantity_sum: row.get("quantity_sum").cloned().unwrap_or(Value::Null),
        resolved_via: via,
        missing: false,
    };
    if let Some(row) = pg::pool_rows(pool, SELLER_BY_NAME, &[Bind::Text(username.to_owned())]).await?.first() {
        return Ok(Some(account(row, "snapshot_name")));
    }
    let ct_user_id = match fetch_card_trader_user_id(state, username).await {
        Ok(id) => id,
        Err(error) => {
            tracing::warn!(error = %error.to_string().chars().take(200).collect::<String>(), "cardtrader-deal-scan CT resolve failed");
            None
        }
    };
    let Some(ct_user_id) = ct_user_id else { return Ok(None) };
    match pg::pool_rows(pool, SELLER_BY_ID, &[Bind::Text(ct_user_id.clone())]).await?.first() {
        Some(row) => Ok(Some(account(row, "cardtrader_user_id"))),
        None => Ok(Some(Account {
            username: username.to_owned(),
            account_id: json!(ct_user_id),
            snapshot_name: Value::Null,
            listing_count: json!(0),
            quantity_sum: json!(0),
            resolved_via: "cardtrader_user_id",
            missing: true,
        })),
    }
}

const LISTINGS_SQL: &str = r#"select distinct on (
        s.blueprint_id::text,
        coalesce(nullif(s.condition, ''), 'Near Mint'),
        lower(coalesce(nullif(s.language, ''), 'en')),
        coalesce((s.properties->>'pokemon_reverse')::boolean, false),
        coalesce((s.properties->>'first_edition')::boolean, false),
        s.price::numeric
      )
        s.blueprint_id::text as blueprint_id,
        s.price::numeric as ask_eur,
        s.quantity::int as quantity,
        coalesce(nullif(s.condition, ''), 'Near Mint') as condition_raw,
        lower(coalesce(nullif(s.language, ''), 'en')) as language_raw,
        coalesce((s.properties->>'pokemon_reverse')::boolean, false) as reverse,
        coalesce((s.properties->>'first_edition')::boolean, false) as first_edition,
        false as graded,
        c.name as card_name,
        c.expansion_name,
        c.card_number,
        c.card_id
      from cardtrader_market_listing_snapshots s
      left join marketplace_search_candidates c
        on c.ct_id::text = s.blueprint_id::text
     where s.seller_account_id = $1
       and s.price::numeric > 0
     order by
        s.blueprint_id::text,
        coalesce(nullif(s.condition, ''), 'Near Mint'),
        lower(coalesce(nullif(s.language, ''), 'en')),
        coalesce((s.properties->>'pokemon_reverse')::boolean, false),
        coalesce((s.properties->>'first_edition')::boolean, false),
        s.price::numeric,
        c.card_id"#;

const LIVE_SQL: &str = r#"select blueprint_id::text as blueprint_id,
            min(price::numeric) as live_cheapest_eur,
            percentile_cont(0.5) within group (order by price::numeric) as live_median_eur,
            count(*)::int as live_listing_count
       from cardtrader_market_listing_snapshots
      where blueprint_id = any($1::bigint[])
        and price::numeric > 0
      group by 1"#;

const SOLD_SQL: &str = r#"with sold_days as (
       select
         d.blueprint_id::text as blueprint_id,
         d.condition as condition_code,
         upper(coalesce(nullif(d.language, ''), 'EN')) as language_code,
         d.reverse,
         d.first_edition,
         d.graded,
         d.observed_day,
         d.median_pkn * 0.005 as day_eur,
         d.sold_qty
       from cardtrader_sold_daily d
      where d.observed_day >= (current_date - ($2::int || ' days')::interval)
        and d.blueprint_id = any($1::bigint[])
        and d.sold_qty > 0
        and d.median_pkn * 0.005 > 0
        and d.median_pkn * 0.005 <= 500
     )
     select
       blueprint_id,
       condition_code,
       language_code,
       reverse,
       first_edition,
       graded,
       percentile_cont(0.5) within group (order by day_eur) as sold_median_eur,
       sum(sold_qty)::int as sold_qty_90d,
       count(*)::int as sold_day_rows,
       max(observed_day) as last_sold_day
     from sold_days
     group by 1, 2, 3, 4, 5, 6"#;

fn n(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        v => Some(js::number(v)),
    }
}

/// `Math.round(x * 100) / 100`.
fn round2(x: f64) -> f64 {
    (x * 100.0 + 0.5).floor() / 100.0
}

fn flag_bit(value: Option<&Value>) -> &'static str {
    if js::truthy(value) { "1" } else { "0" }
}

/// `String(jsDate).slice(0, 10)` of a node-pg `date` (TZ=UTC): `Thu Oct 08`.
fn js_date_string_head(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let date = chrono::NaiveDate::parse_from_str(text.get(..10)?, "%Y-%m-%d").ok()?;
    Some(date.format("%a %b %d").to_string())
}

struct Row {
    v: Value,
    flag: &'static str,
    sold_over_ask: Option<f64>,
    ask_over_sold: Option<f64>,
}

async fn scan_seller_deals(state: &RouteState, account_id: &str) -> Result<Vec<Row>, sqlx::Error> {
    let pool = state.api.read();
    let listings = pg::pool_rows(pool, LISTINGS_SQL, &[Bind::Text(account_id.to_owned())]).await?;
    if listings.is_empty() {
        return Ok(Vec::new());
    }
    let mut blueprint_ids: Vec<i64> = Vec::new();
    for row in &listings {
        if let Ok(id) = js::js_string(row.get("blueprint_id").unwrap_or(&Value::Null)).parse::<i64>() {
            if !blueprint_ids.contains(&id) {
                blueprint_ids.push(id);
            }
        }
    }
    let live_rows = pg::pool_rows(pool, LIVE_SQL, &[Bind::BigIntArray(blueprint_ids.clone())]).await?;
    let live: HashMap<String, (Option<f64>, Option<f64>, f64)> = live_rows
        .iter()
        .map(|r| {
            let count = js::number(r.get("live_listing_count"));
            (js::js_string(r.get("blueprint_id").unwrap_or(&Value::Null)), (n(r.get("live_cheapest_eur")), n(r.get("live_median_eur")), if count.is_finite() { count } else { 0.0 }))
        })
        .collect();
    let sold_rows = pg::pool_rows(pool, SOLD_SQL, &[Bind::BigIntArray(blueprint_ids), Bind::Int(SOLD_WINDOW_DAYS)]).await?;
    let mut sold: HashMap<String, Value> = HashMap::new();
    for row in sold_rows {
        let key = [
            js::js_string(row.get("blueprint_id").unwrap_or(&Value::Null)),
            js::string_or_empty(row.get("condition_code")),
            js::string_or_empty(row.get("language_code")),
            flag_bit(row.get("reverse")).into(),
            flag_bit(row.get("first_edition")).into(),
            flag_bit(row.get("graded")).into(),
        ]
        .join("|");
        sold.insert(key, row);
    }
    let mut out = Vec::new();
    for listing in &listings {
        let condition_code = normalize_condition(&js::string_or_empty(listing.get("condition_raw")));
        let language_code = normalize_language(&js::string_or_empty(listing.get("language_raw")));
        let ask = js::number(listing.get("ask_eur"));
        let blueprint = js::js_string(listing.get("blueprint_id").unwrap_or(&Value::Null));
        let (live_cheapest, live_median, live_count) = live.get(&blueprint).cloned().unwrap_or((None, None, 0.0));
        let key = [blueprint.clone(), condition_code.into(), language_code.clone(), flag_bit(listing.get("reverse")).into(), flag_bit(listing.get("first_edition")).into(), "0".into()].join("|");
        let sold_row = sold.get(&key);
        let mut sold_median = sold_row.and_then(|r| n(r.get("sold_median_eur")));
        let sold_qty = sold_row.and_then(|r| n(r.get("sold_qty_90d"))).unwrap_or(0.0);
        if let (Some(s), Some(l)) = (sold_median, live_median) {
            if s > (l * 25.0).max(5.0) {
                sold_median = None;
            }
        }
        let flag = match sold_median {
            None => "no_sold_match",
            Some(_) if sold_qty < MIN_SOLD_QTY => "thin_sold",
            Some(s) if ask > 0.0 && s / ask >= CHEAP_SOLD_RATIO && live_median.is_some_and(|l| l / ask >= CHEAP_LIVE_RATIO) => "cheap_vs_sold",
            Some(s) if ask > 0.0 && s > 0.0 && ask / s >= EXPENSIVE_SOLD_RATIO && live_median.is_some_and(|l| ask / l >= EXPENSIVE_LIVE_RATIO) => "expensive_vs_sold",
            _ => "ok",
        };
        let sold_over_ask = sold_median.filter(|_| ask > 0.0).map(|s| round2(s / ask));
        let ask_over_sold = sold_median.filter(|s| *s > 0.0).map(|s| round2(ask / s));
        let card_name = listing.get("card_name").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("(unknown)"));
        let quantity = js::number(listing.get("quantity"));
        let last_sold_day = sold_row.and_then(|r| r.get("last_sold_day")).filter(|v| js::truthy(Some(v))).cloned().unwrap_or(Value::Null);
        out.push(Row {
            v: json!({
                "blueprint_id": listing.get("blueprint_id").cloned().unwrap_or(Value::Null),
                "card_id": listing.get("card_id").cloned().unwrap_or(Value::Null),
                "card_name": card_name,
                "expansion_name": listing.get("expansion_name").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("")),
                "card_number": listing.get("card_number").filter(|v| js::truthy(Some(v))).cloned().unwrap_or(json!("")),
                "condition_raw": listing.get("condition_raw").cloned().unwrap_or(Value::Null),
                "condition_code": condition_code,
                "language_raw": listing.get("language_raw").cloned().unwrap_or(Value::Null),
                "language_code": language_code,
                "reverse": js::truthy(listing.get("reverse")),
                "first_edition": js::truthy(listing.get("first_edition")),
                "graded": false,
                "ask_eur": js::js_json_number(round2(ask)),
                "quantity": js::js_json_number(if quantity.is_finite() { quantity } else { 0.0 }),
                "sold_median_eur": sold_median.map(|s| js::js_json_number(round2(s))).unwrap_or(Value::Null),
                "live_cheapest_eur": live_cheapest.map(|s| js::js_json_number(round2(s))).unwrap_or(Value::Null),
                "live_median_eur": live_median.map(|s| js::js_json_number(round2(s))).unwrap_or(Value::Null),
                "live_listing_count": js::js_json_number(live_count),
                "sold_qty_90d": js::js_json_number(sold_qty),
                "last_sold_day": last_sold_day,
            }),
            flag,
            sold_over_ask,
            ask_over_sold,
        });
    }
    let score = |row: &Row| match row.flag {
        "cheap_vs_sold" => row.sold_over_ask.unwrap_or(0.0),
        "expensive_vs_sold" => row.ask_over_sold.unwrap_or(0.0),
        _ => 0.0,
    };
    out.sort_by(|a, b| pokoin_sort::cmp_f64_desc(score(a), score(b)));
    Ok(out)
}

fn deal_dto(row: &Row) -> Value {
    let v = &row.v;
    let card_id = v.get("card_id").filter(|c| !c.is_null()).map(|c| json!(js::js_string(c))).unwrap_or(Value::Null);
    let pokoin_url = v.get("card_id").filter(|c| js::truthy(Some(c))).map(|c| json!(format!("https://pokoin.com/{}", js::js_string(c)))).unwrap_or(Value::Null);
    json!({
        "blueprintId": js::js_string(v.get("blueprint_id").unwrap_or(&Value::Null)),
        "cardId": card_id,
        "cardName": v["card_name"],
        "expansionName": v["expansion_name"],
        "cardNumber": v["card_number"],
        "condition": v["condition_code"],
        "conditionRaw": v["condition_raw"],
        "language": v["language_code"],
        "languageRaw": v["language_raw"],
        "reverse": v["reverse"],
        "firstEdition": v["first_edition"],
        "graded": false,
        "askEur": v["ask_eur"],
        "quantity": v["quantity"],
        "soldMedianEur": v["sold_median_eur"],
        "liveCheapestEur": v["live_cheapest_eur"],
        "liveMedianEur": v["live_median_eur"],
        "liveListingCount": v["live_listing_count"],
        "soldQty90d": v["sold_qty_90d"],
        "lastSoldDay": js_date_string_head(&v["last_sold_day"]).map(Value::String).unwrap_or(Value::Null),
        "flag": row.flag,
        "soldOverAsk": row.sold_over_ask.map(js::js_json_number).unwrap_or(Value::Null),
        "askOverSold": row.ask_over_sold.map(js::js_json_number).unwrap_or(Value::Null),
        "pokoinUrl": pokoin_url,
    })
}

fn reply(status: StatusCode, body: Value) -> Response {
    http::json(status, body)
}

pub async fn handler(State(state): State<RouteState>, method: Method, headers: HeaderMap, uri: Uri) -> Response {
    if expected_token().is_empty() {
        return reply(StatusCode::SERVICE_UNAVAILABLE, json!({ "ok": false, "error": "deal-scan not configured: DEAL_SCAN_TOKEN missing" }));
    }
    if !is_authorized(&headers) {
        return reply(StatusCode::UNAUTHORIZED, json!({ "ok": false, "error": "unauthorized" }));
    }
    if method != Method::GET {
        return reply(StatusCode::METHOD_NOT_ALLOWED, json!({ "ok": false, "error": "GET only" }));
    }
    let failure = || reply(StatusCode::INTERNAL_SERVER_ERROR, json!({ "ok": false, "error": "deal scan failed" }));
    let q = http::Query::from_uri(&uri);
    let username = match parse_seller_input(q.search_param("seller"), q.search_param("url")) {
        Err(()) => return failure(),
        Ok(Seller::Bad(error)) => return reply(StatusCode::BAD_REQUEST, json!({ "ok": false, "error": error })),
        Ok(Seller::Ok(username)) => username,
    };
    let seller = match resolve_seller_account(&state, &username).await {
        Ok(Some(seller)) => seller,
        Ok(None) => return reply(StatusCode::NOT_FOUND, json!({ "ok": false, "error": format!("seller not found: {username}"), "username": username })),
        Err(error) => {
            tracing::error!(%error, "cardtrader-deal-scan");
            return failure();
        }
    };
    if seller.missing || js::number(Some(&seller.listing_count)) == 0.0 {
        return reply(
            StatusCode::NOT_FOUND,
            json!({
                "ok": false,
                "error": "seller has no listings in the current CardTrader snapshot book",
                "seller": { "username": seller.username, "accountId": seller.account_id, "snapshotName": seller.snapshot_name, "listingCount": 0, "resolvedVia": seller.resolved_via },
            }),
        );
    }
    let rows = match scan_seller_deals(&state, &js::js_string(&seller.account_id)).await {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "cardtrader-deal-scan");
            return failure();
        }
    };
    let (mut cheap, mut expensive) = (Vec::new(), Vec::new());
    let (mut unmatched, mut thin, mut ok) = (0, 0, 0);
    for row in &rows {
        match row.flag {
            "cheap_vs_sold" => {
                if cheap.len() < MAX_DEALS_EACH {
                    cheap.push(deal_dto(row));
                }
            }
            "expensive_vs_sold" => {
                if expensive.len() < MAX_DEALS_EACH {
                    expensive.push(deal_dto(row));
                }
            }
            "no_sold_match" => unmatched += 1,
            "thin_sold" => thin += 1,
            _ => ok += 1,
        }
    }
    let key = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    cheap.sort_by(|a, b| pokoin_sort::cmp_f64_desc(key(a, "soldOverAsk"), key(b, "soldOverAsk")));
    expensive.sort_by(|a, b| pokoin_sort::cmp_f64_desc(key(a, "askOverSold"), key(b, "askOverSold")));
    reply(
        StatusCode::OK,
        json!({
            "ok": true,
            "product": "cardtrader_deal_scan",
            "match": "facet_perfect",
            "matchFields": ["blueprint_id", "condition", "language", "reverse", "first_edition", "graded"],
            "soldWindowDays": SOLD_WINDOW_DAYS,
            "minSoldQty": 3,
            "gates": {
                "cheap": { "soldOverAsk": 3, "liveMedianOverAsk": 2 },
                "expensive": { "askOverSold": 4, "askOverLiveMedian": 3 },
            },
            "seller": {
                "username": seller.username,
                "accountId": seller.account_id,
                "snapshotName": seller.snapshot_name,
                "listingCount": seller.listing_count,
                "quantitySum": seller.quantity_sum,
                "resolvedVia": seller.resolved_via,
                "profileUrl": format!("https://www.cardtrader.com/en/users/{}", encode_uri_component(&seller.username)),
            },
            "scannedListings": rows.len(),
            "unmatchedCount": unmatched,
            "thinSoldCount": thin,
            "okCount": ok,
            "deals": { "cheap": cheap, "expensive": expensive },
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizers() {
        assert_eq!(normalize_condition("Near Mint"), "NM");
        assert_eq!(normalize_condition("heavily played"), "PL");
        assert_eq!(normalize_condition("weird"), "NM");
        assert_eq!(normalize_language("japanese"), "JP");
        assert_eq!(normalize_language("zht"), "ZHT");
        assert_eq!(normalize_language("xx"), "EN");
        assert!(matches!(parse_seller_input(None, Some("https://www.cardtrader.com/en-US/users/olive%20x")), Ok(Seller::Ok(u)) if u == "olive x"));
        assert!(matches!(parse_seller_input(Some("@olivefrancesco10/"), None), Ok(Seller::Ok(u)) if u == "olivefrancesco10"));
        assert!(matches!(parse_seller_input(Some("https://x.com/a"), None), Ok(Seller::Bad(_))));
        assert_eq!(round2(2.345), 2.35);
        assert_eq!(js_date_string_head(&json!("2026-10-08T00:00:00.000Z")).unwrap(), "Thu Oct 08");
    }
}
