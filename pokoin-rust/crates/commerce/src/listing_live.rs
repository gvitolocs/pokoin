//! Public listing serialization and the native CardTrader offer merge.
use crate::{
    error::ApiError,
    seller_cache::{self, ProfileCache},
    state::DomainState,
};
use regex::Regex;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;
pub const RESERVE: &str = "pknreserve";
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n
            .as_f64()
            .map(|f| f.to_string())
            .unwrap_or_else(|| n.to_string()),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
pub fn text(value: &Value, max: usize) -> String {
    let raw = if value.is_null() || value == false || value.as_f64() == Some(0.0) {
        String::new()
    } else {
        js_string(value)
    };
    raw.trim()
        .chars()
        .scan(0usize, |used, ch| {
            *used += ch.len_utf16();
            (*used <= max).then_some(ch)
        })
        .collect()
}
pub fn field(value: &Value, key: &str, max: usize) -> String {
    text(&value[key], max)
}
pub fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().map(|n| n != 0.0).unwrap_or(false),
        _ => true,
    }
}
pub fn first(value: &Value, keys: &[&str], max: usize) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).filter(|v| js_truthy(v)))
        .map(|v| text(v, max))
        .unwrap_or_default()
}
pub fn number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => pokoin_api_common::http::js_number(s).unwrap_or(f64::NAN),
        Value::Array(_) => {
            pokoin_api_common::http::js_number(&js_string(value)).unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}
/// JSON.stringify renders integral JavaScript numbers without a decimal suffix.
pub fn json_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        json!(n as i64)
    } else {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}
pub fn clean_username(value: &str) -> String {
    let s = text(&json!(value), 64).to_lowercase();
    let valid = Regex::new(r"^[\p{L}\p{N} .'_-]{3,64}$")
        .ok()
        .map(|r| r.is_match(&s))
        .unwrap_or(false);
    if valid && s.chars().any(char::is_alphabetic) {
        s
    } else {
        String::new()
    }
}
pub fn reserve_body(body: &Value) -> bool {
    let source = field(body, "source", 80).to_lowercase();
    let id = field(body, "sourceListingId", 160).to_lowercase();
    body["reserveAvailable"] == true
        || ["reserve", "pokoin_reserve", "pknreserve"].contains(&source.as_str())
        || source.starts_with("reserve_")
        || source.starts_with("pokoin_reserve_")
        || id.starts_with("reserve:")
        || id.starts_with("pknreserve:")
}
pub fn reserve_row(row: &Value) -> bool {
    row["reserve_available"] == true
        || reserve_body(&json!({"source":row["source"],"sourceListingId":row["source_listing_id"]}))
}
pub fn public_comment(value: &Value) -> String {
    let mut s = text(value, 500);
    for pattern in [
        r"(?is)<script\b[^>]*>.*?</script>",
        r"(?is)<style\b[^>]*>.*?</style>",
        r"<[^>]*>",
    ] {
        if let Ok(re) = Regex::new(pattern) {
            s = re.replace_all(&s, "").into_owned();
        }
    }
    s = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let normalized: String = s
        .nfkd()
        .filter(|c| !(('\u{0300}'..='\u{036f}').contains(c)))
        .collect::<String>()
        .to_lowercase();
    let normalized = Regex::new(r"[^a-z0-9@./:_+\-]+")
        .ok()
        .map(|r| r.replace_all(&normalized, " ").into_owned())
        .unwrap_or(normalized);
    let patterns = [
        r"\bcheck\s+(?:out\s+)?my\s+(?:store|shop|profile|page|cards|listings|other\s+items)\b",
        r"\bvisit\s+my\s+(?:store|shop|profile|page)\b",
        r"\bsee\s+my\s+(?:store|shop|profile|page|other\s+cards|listings)\b",
        r"\bmore\s+(?:cards|items|listings|products)\s+available\b",
        r"\b(?:other|more)\s+(?:cards|items|listings|products)\s+(?:in|on)\s+my\s+(?:store|shop|profile|page)\b",
        r"\b(?:message|contact|dm|pm)\s+me\b",
        r"\b(?:whatsapp|telegram|instagram|facebook|discord|ebay|vinted)\b",
        r"(?:https?://|www\.|(?:^|\s)[a-z0-9-]+\.(?:com|it|net|org|shop)\b)",
    ];
    if patterns.iter().any(|p| {
        Regex::new(p)
            .ok()
            .map(|r| r.is_match(&normalized))
            .unwrap_or(false)
    }) {
        String::new()
    } else {
        s
    }
}
pub fn listing_row(row: &Value, owner: bool) -> Value {
    let source = first(row, &["source"], 80);
    let source = if source.is_empty() {
        "pokoin_user_listing".to_string()
    } else {
        source
    };
    let reserve = reserve_row(row) || source.to_lowercase() == "cardtrader_live";
    let display = if reserve {
        RESERVE.to_string()
    } else {
        let s = first(
            row,
            &[
                "profile_display_name",
                "profile_username",
                "display_name",
                "username",
                "seller_name",
            ],
            120,
        );
        if s.is_empty() {
            "Pokoin seller".to_string()
        } else {
            s
        }
    };
    let claimed = clean_username(&field(row, "profile_username", 120));
    let username = if reserve {
        RESERVE.to_string()
    } else if !claimed.is_empty() && claimed != RESERVE {
        claimed
    } else {
        clean_username(&field(row, "seller_name", 120))
    };
    let mut out = json!({"sellerName":display,"sellerDisplayName":display,"sellerUsername":username,"marketplaceGame":first(row,&["marketplace_game","marketplaceGame"],40),"pricePkn":json_number(if row["price_pkn"].is_null(){0.0}else{number(&row["price_pkn"])}),"quantityAvailable":json_number(if row["quantity_available"].is_null(){0.0}else{number(&row["quantity_available"])}),"sellerAcceptsPkn":row["profile_accepts_pkn"]!=false,"foilState":first(row,&["foil_state"],40),"variantState":field(row,"variant_state",80),"shippingAvailable":row["shipping_available"]!=false,"sellerComment":public_comment(&row["seller_comment"]),"source":source,"sourceListingId":field(row,"source_listing_id",160),"canonicalPath":first(row,&["canonical_path","canonicalPath"],800),"publicNumber":first(row,&["public_number","publicNumber"],80),"sourceMetadata":row.get("source_metadata").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!({})),"photoUrls":row["photo_urls"].as_array().map(|a|a.iter().filter(|v|v.is_string()).take(2).cloned().collect::<Vec<_>>()).unwrap_or_default()});
    if out["marketplaceGame"] == "" {
        out["marketplaceGame"] = json!("pokemon");
    }
    if out["foilState"] == "" {
        out["foilState"] = json!("standard");
    }
    for (dest, src) in [
        ("id", "id"),
        ("cardId", "card_id"),
        ("sellerUid", "seller_uid"),
        ("sellerCountry", "seller_country"),
        ("sellerReputationLabel", "seller_reputation_label"),
        ("condition", "condition"),
        ("language", "language"),
        ("gradingCompany", "grading_company"),
        ("grade", "grade"),
        ("certificationId", "certification_id"),
        ("status", "status"),
        ("cardName", "card_name"),
        ("cardImageUrl", "card_image_url"),
        ("setName", "set_name"),
        ("collectorNumber", "collector_number"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        if let Some(v) = row.get(src) {
            let v = if src.ends_with("_at") {
                v.as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|dt| {
                        json!(dt
                            .with_timezone(&chrono::Utc)
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    })
                    .unwrap_or_else(|| v.clone())
            } else {
                v.clone()
            };
            out[dest] = v;
        }
    }
    for (dest, src) in [
        ("signed", "signed"),
        ("reverse", "reverse"),
        ("firstEdition", "first_edition"),
        ("altered", "altered"),
        ("sealed", "sealed"),
        ("graded", "graded"),
        ("reserveAvailable", "reserve_available"),
        ("nftAvailable", "nft_available"),
    ] {
        out[dest] = json!(row[src] == true);
    }
    for (key, raw, fallback) in [
        ("source", "source", json!("pokoin_user_listing")),
        ("sourceListingId", "source_listing_id", json!("")),
        ("foilState", "foil_state", json!("standard")),
        ("variantState", "variant_state", json!("")),
        ("sourceMetadata", "source_metadata", json!({})),
    ] {
        out[key] = row
            .get(raw)
            .filter(|v| js_truthy(v))
            .cloned()
            .unwrap_or(fallback);
    }
    if owner {
        out["location"] = row
            .get("location")
            .filter(|v| js_truthy(v))
            .cloned()
            .unwrap_or_else(|| json!(""));
    }
    out
}
pub async fn enrich_sellers(state: &DomainState, rows: &mut [Value]) {
    let mut uids = Vec::new();
    for row in rows.iter() {
        let uid = field(row, "seller_uid", 160);
        if !uid.is_empty() && !reserve_row(row) && !uids.contains(&uid) {
            uids.push(uid);
        }
    }
    if uids.is_empty() {
        return;
    }
    let cache = state.profile_cache();
    let results=futures_util::future::join_all(uids.into_iter().map(|uid|{let cache=&cache;async move{
        if let Some(c)=cache {if let Some(raw)=c.get(&seller_cache::seller_profile_key(&uid)).await {if let Ok(v)=serde_json::from_str::<Value>(&raw){if v.is_object()&&(!v["displayName"].is_null()||!v["username"].is_null()||v["acceptsPkn"].is_boolean()){return Ok::<_,ApiError>((uid,Some(v)));}}}}
        let fs=state.firestore()?;let doc=fs.get_document(&fs.document_path("users",&uid)).await?;let profile=doc.map(|d|json!({"displayName":field(&d,"displayName",120),"username":first(&d,&["username","usernameLower"],120),"acceptsPkn":d["acceptsPkn"]!=false}));
        if let (Some(c),Some(p))=(cache,&profile){c.set_ex(&seller_cache::seller_profile_key(&uid),&p.to_string(),seller_cache::PUBLIC_PROFILE_TTL_SEC).await;}Ok((uid,profile))
    }})).await;
    let Ok(results) = results.into_iter().collect::<Result<Vec<_>, _>>() else {
        return;
    };
    let profiles: HashMap<_, _> = results
        .into_iter()
        .filter_map(|(uid, p)| p.map(|p| (uid, p)))
        .collect();
    for row in rows.iter_mut() {
        if let Some(p) = profiles.get(&field(row, "seller_uid", 160)) {
            row["profile_display_name"] = p["displayName"].clone();
            row["profile_username"] = p["username"].clone();
            row["profile_accepts_pkn"] = p["acceptsPkn"].clone();
        }
    }
}
pub async fn enrich_urls(state: &DomainState, rows: &mut [Value]) {
    let ids: Vec<i64> = rows
        .iter()
        .filter_map(|r| field(r, "card_id", 80).parse().ok())
        .collect();
    if ids.is_empty() {
        return;
    }
    let result=sqlx::query("select distinct on (card_id) card_id::text as card_id, canonical_path::text as canonical_path, split_part(split_part(canonical_path, '/cards/', 2), '/', 1) as public_number from public.marketplace_card_urls where card_id = any($1::bigint[]) and language = 'en' order by card_id, canonical_path").bind(&ids).fetch_all(state.read_db()).await;
    let Ok(urls) = result else { return };
    let urls: HashMap<String, (String, String)> = urls
        .into_iter()
        .filter_map(|r| {
            Some((
                r.try_get("card_id").ok()?,
                (
                    r.try_get("canonical_path").ok()?,
                    r.try_get("public_number").ok()?,
                ),
            ))
        })
        .collect();
    for row in rows.iter_mut() {
        if let Some((path, num)) = urls.get(&field(row, "card_id", 80)) {
            row["canonical_path"] = json!(path);
            row["public_number"] = json!(num);
        }
    }
}
pub async fn seller_profile(
    state: &DomainState,
    username: &str,
    listings_first: bool,
) -> Result<Value, ApiError> {
    let clean = clean_username(username);
    if clean.is_empty() {
        return Err(ApiError::bad_request("Seller username is invalid."));
    }
    let cache = state.profile_cache();
    let key = seller_cache::seller_slug_key(&clean);
    if let Some(c) = &cache {
        if let Some(raw) = c.get(&key).await {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if Regex::new(r"^[A-Za-z0-9:_-]{4,160}$")
                    .ok()
                    .map(|r| r.is_match(&field(&v, "uid", 160)))
                    .unwrap_or(false)
                {
                    return Ok(
                        json!({"uid":v["uid"],"username":clean,"displayName":field(&v,"displayName",120)}),
                    );
                }
            }
        }
    }
    let mut uid = String::new();
    let mut display = String::new();
    if listings_first {
        uid=sqlx::query_scalar::<_,String>("select seller_uid from public.marketplace_user_listings where lower(btrim(seller_name)) = $1 and seller_uid is not null and btrim(seller_uid) <> '' order by updated_at desc nulls last, created_at desc nulls last limit 1").bind(&clean).fetch_optional(state.read_db()).await.ok().flatten().unwrap_or_default();
    }
    if uid.is_empty() {
        let fs = state.firestore()?;
        let doc = fs
            .get_document(&fs.document_path("usernames", &clean))
            .await?
            .unwrap_or_else(|| json!({}));
        uid = field(&doc, "uid", 160);
        display = field(&doc, "displayName", 120);
        if uid.is_empty() {
            let docs = fs
                .run_query(
                    &crate::StructuredQuery::collection("users")
                        .where_eq("usernameLower", json!(clean))
                        .limit(1),
                )
                .await?;
            if let Some(doc) = docs.first() {
                uid = first(doc, &["uid", "id"], 160);
                display = field(doc, "displayName", 120);
            }
        }
    }
    if uid.is_empty() {
        return Err(ApiError::not_found("Seller not found."));
    }
    if let Some(c) = cache {
        c.set_ex(
            &key,
            &json!({"uid":uid,"displayName":display}).to_string(),
            seller_cache::PUBLIC_PROFILE_TTL_SEC,
        )
        .await;
    }
    Ok(json!({"uid":uid,"username":clean,"displayName":display}))
}
pub fn foil_state(props: &Value) -> String {
    if text(&props["pokemon_reverse"], 40).to_lowercase() == "true" {
        return "reverse".into();
    }
    let s = first(props, &["foil_state", "foilState"], 40).to_lowercase();
    if [
        "reverse", "holo", "foil", "stamped", "promo", "other", "standard",
    ]
    .contains(&s.as_str())
    {
        return s;
    }
    if let Some(obj) = props.as_object() {
        for (k, v) in obj {
            let k = k.to_lowercase();
            if (k == "foil" || k == "mtg_foil" || k.ends_with("_foil"))
                && (v == true
                    || ["true", "yes", "1", "foil"].contains(&text(v, 40).to_lowercase().as_str()))
            {
                return "foil".into();
            }
        }
    }
    "standard".into()
}
pub fn synthetic_listing(listing: &Value, seller: &Value, fallback: &str) -> Option<Value> {
    let external = first(
        listing,
        &[
            "externalProductId",
            "cardtraderProductId",
            "externalListingId",
        ],
        120,
    );
    if external.is_empty() || listing["displayPricePkn"].is_null() {
        return None;
    }
    let id = format!("cardtrader:live:{external}");
    let mut foil = field(listing, "foilState", 40);
    if foil.is_empty() {
        foil = foil_state(&listing["properties"]);
    }
    let card = if fallback.trim().is_empty() {
        first(listing, &["pokoinCardId", "blueprintId"], 80)
    } else {
        fallback.to_string()
    };
    let language = field(listing, "language", 10).to_uppercase();
    let condition = field(listing, "condition", 20);
    let set = field(&listing["expansion"], "name", 240);
    let currency = field(listing, "currency", 12);
    Some(
        json!({"id":id,"cardId":card,"sellerUid":seller["uid"],"sellerName":RESERVE,"sellerCountry":field(&listing["seller"],"country",40),"sellerReputationLabel":RESERVE,"condition":if condition.is_empty(){"NM"}else{&condition},"language":if language.is_empty(){"EN"}else{&language},"pricePkn":json_number(number(&listing["displayPricePkn"])),"quantityAvailable":json_number(number(&listing["quantity"]).max(0.0)),"signed":false,"reverse":foil=="reverse","firstEdition":false,"foilState":foil,"variantState":first(&listing["properties"],&["variant_state","variantState"],80),"sealed":false,"graded":listing["graded"]==true,"gradingCompany":null,"grade":null,"certificationId":null,"shippingAvailable":true,"reserveAvailable":true,"nftAvailable":true,"sellerComment":public_comment(&listing["sellerComment"]),"source":"cardtrader_live","sourceListingId":id,"sourceMetadata":{"provider":"cardtrader","externalListingId":field(listing,"externalListingId",120),"externalProductId":first(listing,&["externalProductId","cardtraderProductId"],120),"cardtraderProductId":first(listing,&["cardtraderProductId","externalProductId"],120),"cardtraderBlueprintId":field(listing,"cardtraderBlueprintId",80),"sourceSellerName":first(&listing["seller"],&["sourceAccountName","accountName"],120),"shippingMode":field(listing,"shippingMode",40),"shippingLabel":field(listing,"shippingLabel",80),"sellerComment":public_comment(&listing["sellerComment"]),"sourcePrice":if listing["price"].is_null(){Value::Null}else{json_number(number(&listing["price"]))},"sourceCurrency":if currency.is_empty(){"EUR"}else{&currency},"markupPkn":0,"nftTag":true},"status":"active","cardName":field(listing,"name",240),"cardImageUrl":"","setName":if set.is_empty(){"Pokemon"}else{&set},"collectorNumber":field(listing,"externalListingId",80),"canonicalPath":"","publicNumber":"","createdAt":null,"updatedAt":null}),
    )
}
pub async fn live_offers(state: &DomainState, card: &str, limit: i64, game: &str) -> Vec<Value> {
    let seller = seller_profile(state, RESERVE, false)
        .await
        .unwrap_or_else(|_| json!({"uid":RESERVE,"username":RESERVE,"displayName":RESERVE}));
    let db = pokoin_external::db::DbPools::lazy(state.read_db().clone(), state.write_db().clone());
    let ct = pokoin_external::cardtrader::client::CardTraderClient::new();
    let cache = pokoin_external::redis::RedisCache::from_env();
    let request = pokoin_external::cardtrader_live::LiveRequest {
        blueprint_id: String::new(),
        card_id: card.to_string(),
        requested_id: card.to_string(),
        requested_param: "cardId",
        language: String::new(),
        limit: Some(limit),
    };
    let result = pokoin_external::cardtrader_live::read_live_listings(
        &db,
        &ct,
        cache.as_ref(),
        &request,
        game,
    )
    .await;
    result
        .ok()
        .and_then(|v| v["listings"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|v| synthetic_listing(v, &seller, card))
        .filter(|v| number(&v["quantityAvailable"]) > 0.0 && number(&v["pricePkn"]) > 0.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn row_preserves_contract_and_hides_private_location() {
        let row = json!({"id":"id-1","card_id":"220962","seller_uid":"u1","seller_name":"Alice Smith","profile_display_name":"Alice","profile_username":"alice","profile_accepts_pkn":false,"price_pkn":"2642.25","quantity_available":3,"location":"BIN-07 ","photo_urls":["one",1,"two","three"],"canonical_path":"/marketplace/cards/220962/espurr","created_at":"2026-10-09T08:04:02.000000+00:00","seller_comment":"<b>Tiny corner scratch</b>"});
        let public = listing_row(&row, false);
        assert_eq!(public["sellerName"], "Alice");
        assert_eq!(public["sellerDisplayName"], "Alice");
        assert_eq!(public["sellerUsername"], "alice");
        assert_eq!(public["sellerAcceptsPkn"], false);
        assert_eq!(public["pricePkn"], 2642.25);
        assert_eq!(public["createdAt"], "2026-10-09T08:04:02.000Z");
        assert_eq!(public["photoUrls"], json!(["one", "two"]));
        assert_eq!(public["sellerComment"], "Tiny corner scratch");
        assert_eq!(public["sourceMetadata"], json!({}));
        assert!(public.get("location").is_none());
        assert_eq!(listing_row(&row, true)["location"], "BIN-07 ");
        assert!(public.get("sellerCountry").is_none());
    }
    #[test]
    fn reserve_names_cannot_be_replaced_by_profiles() {
        for row in [
            json!({"reserve_available":true}),
            json!({"source":"cardtrader_live"}),
            json!({"source":"pokoin_reserve_ready"}),
            json!({"source_listing_id":"pknreserve:123"}),
        ] {
            let mut row = row;
            row["profile_display_name"] = json!("Other name");
            row["seller_name"] = json!("Alice");
            let p = listing_row(&row, false);
            assert_eq!(p["sellerName"], RESERVE);
            assert_eq!(p["sellerUsername"], RESERVE);
        }
    }
    #[test]
    fn username_validation_accepts_native_seller_names() {
        assert_eq!(clean_username(" Raffaella Sabatino "), "raffaella sabatino");
        assert_eq!(clean_username("Jörg"), "jörg");
        assert_eq!(clean_username("___"), "");
        assert_eq!(clean_username("123"), "");
        assert_eq!(clean_username("a/b"), "");
    }
    #[test]
    fn public_comment_removes_markup_and_promotions() {
        assert_eq!(
            public_comment(&json!(
                "<script>alert('x')</script><b>Excellent</b>\ncondition"
            )),
            "Excellent condition"
        );
        for s in [
            "Check out my shop",
            "Méssage me",
            "visit my store",
            "cards at www.example.com",
            "Telegram me",
        ] {
            assert_eq!(public_comment(&json!(s)), "", "{s}");
        }
        assert_eq!(
            public_comment(&json!("Front clean, light scratches on the back.")),
            "Front clean, light scratches on the back."
        );
    }
    #[test]
    fn synthetic_cardtrader_offer_keeps_public_id_and_exact_shape() {
        let p=synthetic_listing(&json!({"externalProductId":"44","externalListingId":"44","cardtraderBlueprintId":"400585","blueprintId":"400585","displayPricePkn":200,"quantity":2,"name":"Sanction","properties":{"mtg_foil":"yes","variant_state":"etched"},"seller":{"country":"DE","accountName":"source"}}),&json!({"uid":"reserve-uid"}),"801170").unwrap();
        assert_eq!(p["cardId"], "801170");
        assert_eq!(p["id"], "cardtrader:live:44");
        assert_eq!(p["foilState"], "foil");
        assert_eq!(p["sourceMetadata"]["sourceSellerName"], "source");
        assert_eq!(p["reserveAvailable"], true);
        assert_eq!(p["nftAvailable"], true);
        assert!(p.get("marketplaceGame").is_none());
        assert!(p.get("sellerDisplayName").is_none());
        assert!(p.get("photoUrls").is_none());
        assert!(synthetic_listing(&json!({"externalProductId":"44"}), &json!({}), "1").is_none());
    }
    #[test]
    fn foil_properties_follow_node_priority() {
        assert_eq!(
            foil_state(&json!({"pokemon_reverse":"TRUE","foil_state":"holo"})),
            "reverse"
        );
        assert_eq!(
            foil_state(&json!({"foilState":"stamped","mtg_foil":true})),
            "stamped"
        );
        assert_eq!(foil_state(&json!({"foil":"false"})), "standard");
    }
    #[test]
    fn text_uses_js_utf16_length() {
        assert_eq!(text(&json!(" A😀B "), 3), "A😀");
        assert_eq!(text(&json!(false), 80), "");
        assert_eq!(text(&json!(42), 80), "42");
    }
}

#[cfg(test)]
mod mock_profile_tests {
    use super::*;
    use async_trait::async_trait;
    use axum::{extract::Path, routing::get, Json, Router};
    use std::sync::Arc;
    struct Reject;
    #[async_trait]
    impl crate::TokenVerifier for Reject {
        async fn verify(&self, _: &str) -> Result<crate::Claims, crate::auth::AuthError> {
            Err(crate::auth::AuthError::Missing)
        }
    }
    #[test]
    fn number_and_text_match_javascript_coercion() {
        assert_eq!(number(&json!(null)), 0.0);
        assert_eq!(number(&json!("")), 0.0);
        assert_eq!(number(&json!("0x10")), 16.0);
        assert!(number(&json!("1,5")).is_nan());
        assert_eq!(number(&json!(["3"])), 3.0);
        assert!(number(&json!([1, 2])).is_nan());
        assert_eq!(text(&json!({"a":1}), 100), "[object Object]");
        assert_eq!(text(&json!(["a", null, "b"]), 100), "a,,b");
        assert_eq!(first(&json!({"a":"  ","b":"EN"}), &["a", "b"], 10), "");
        assert_eq!(json_number(2.0), json!(2));
        assert_eq!(json_number(f64::NAN), Value::Null);
    }
    #[tokio::test]
    async fn seller_enrichment_reads_firestore_native_and_skips_reserve_rows() {
        let paths = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let captures = paths.clone();
        let app=Router::new().route("/{*path}",get(move|Path(path):Path<String>|{let captures=captures.clone();async move{captures.lock().await.push(path.clone());Json(json!({"name":format!("projects/test/databases/(default)/documents/{path}"),"fields":crate::firestore::value_to_fields(&json!({"displayName":"Alice Smith","username":"alice","acceptsPkn":false}))}))}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let fs = crate::FirestoreClient::with_static_token(
            reqwest::Client::new(),
            "test",
            format!("http://{address}"),
            "test-token",
        );
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://x@127.0.0.1:1/x")
            .unwrap();
        let state = DomainState::with_pools(
            crate::CommerceConfig::default(),
            pool.clone(),
            pool,
            None,
            Arc::new(Reject),
            Some(fs),
        );
        let mut rows = vec![
            json!({"seller_uid":"u1","seller_name":"Native name"}),
            json!({"seller_uid":"u1"}),
            json!({"seller_uid":"reserve-id","source":"pokoin_reserve"}),
        ];
        enrich_sellers(&state, &mut rows).await;
        server.abort();
        assert_eq!(paths.lock().await.len(), 1);
        assert_eq!(listing_row(&rows[0], false)["sellerName"], "Alice Smith");
        assert_eq!(listing_row(&rows[1], false)["sellerUsername"], "alice");
        assert_eq!(listing_row(&rows[0], false)["sellerAcceptsPkn"], false);
        assert!(rows[2].get("profile_display_name").is_none());
    }
}
