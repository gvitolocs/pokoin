use std::collections::HashMap;
use std::time::Instant;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use pokoin_search::{
    clean_print_language, clean_text, page_body, rank_rows,
    redis_search_query, SearchRow,
};
use serde_json::json;

use crate::suggest::{cors, game_from};
use crate::AppState;

pub async fn options() -> Response {
    cors(StatusCode::NO_CONTENT, None, None, "").into_response()
}

pub async fn search_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: axum::http::Uri,
) -> Response {

    let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("");
    let query_string = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let params: Vec<(String, String)> =
        serde_urlencoded::from_str(query_string).unwrap_or_default();
    let param = |name: &str| {
        params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    // Opt-in compact encoding; the default representation is unchanged.
    let wanted = crate::catalog_api::wanted(&headers, &uri);
    let game = game_from(&headers, param("game").or_else(|| param("marketplaceGame")));
    let query = clean_text(param("query").or_else(|| param("q")).unwrap_or(""), 180);
    let product_type = clean_text(param("productType").unwrap_or(""), 60);
    let product_search_only = param("productSearchOnly") == Some("1");
    let include_facets = param("includeFacets") != Some("0");
    let lang_raw = clean_text(
        param("search_language")
            .or_else(|| param("lang"))
            .or_else(|| param("language"))
            .unwrap_or("en"),
        12,
    );
    let lang = if lang_raw.is_empty() { "en".into() } else { lang_raw };
    let limit = parse_limit(param("limit"), 100, 100);
    let offset = parse_offset(param("offset"));
    let print_language = clean_print_language(
        param("print_language")
            .or_else(|| param("printLanguage"))
            .unwrap_or("all"),
    );
    let Some(pool)=crate::catalog_api::game_pool(&state,&game).await else {
        return crate::catalog_api::response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Marketplace database unavailable."}),"no-store")
    };
    if game!="pokemon" || product_search_only || product_type=="jumbo" || query.is_empty() {
        return sql_search_page(wanted,&pool,&query,&game,&product_type,product_search_only,&lang,limit,offset,include_facets).await
    }
    let started = Instant::now();
    let fetch_limit = (limit + 1).clamp(1, 101);
    let found = match filtered_candidates(&state,&pool,&query,&print_language,&product_type,fetch_limit,offset).await {
        Ok(found) => found,
        Err(error) => {
            tracing::error!(%error, "redis search page failed");
            return crate::catalog_api::response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Marketplace search temporarily unavailable."}),"no-store");
        }
    };
    state.meili_ms.fetch_add(
        started.elapsed().as_millis() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    let sql_started = Instant::now();
    let ids=found.hits.iter().map(|h|h.card_id).collect::<Vec<_>>();
    let raw=match crate::catalog_api::cards(&pool,&ids,&game).await {Ok(r)=>r,Err(e)=>return crate::catalog_api::failure(&e)};
    let raw_map:HashMap<i64,serde_json::Value>=raw.into_iter().filter_map(|r|Some((crate::catalog_api::positive_id(&pokoin_catalog::card::text(&r,&["card_id"]))?,r))).collect();
    let mut rows=found.hits.iter().enumerate().filter_map(|(index,hit)|raw_map.get(&hit.card_id).map(|r|rank_record(r,hit.weight,index))).collect::<Vec<_>>();
    state.sql_ms.fetch_add(
        sql_started.elapsed().as_millis() as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    if !product_type.is_empty() {
        rows.retain(|row| row.product_type == product_type);
    }
    // The window holds limit + 1 rows to detect hasMore. Rank only this page:
    // ranking the look-ahead row in would show it here and again on the next
    // page, and push one of this page's rows out of both.
    let fetched = rows.len();
    rows.truncate(limit as usize);
    rank_rows(&mut rows, &query);
    let mut page_rows=rows.into_iter().take(limit as usize).filter_map(|row|raw_map.get(&row.card_id).cloned()).collect::<Vec<_>>();
    if let Err(error)=crate::catalog_api::localize(&pool,&mut page_rows,&lang,&game).await {return crate::catalog_api::failure(&error)}
    let cards=page_rows.iter().map(pokoin_catalog::react_record).collect::<Vec<_>>();
    let mut body = page_body(
        &query,
        &game,
        &product_type,
        false,
        &lang,
        limit,
        offset,
        found.total,
        cards,
    );
    if include_facets {
        match facets(&pool,&query,&lang).await {Ok(products)=>body["facets"]["products"]=serde_json::json!(products),Err(e)=>return crate::catalog_api::failure(&e)}
    }
    if let Some(flag) = body.get_mut("hasMore") {
        *flag = serde_json::json!(fetched as i64 > limit);
    }
    tracing::info!(
        redis_ms = started.elapsed().as_millis() as u64,
        rows = fetched,
        "search page"
    );
    let mut response = crate::catalog_api::response_c1(
        wanted,
        StatusCode::OK,
        body,
        "public, max-age=15, s-maxage=60, stale-while-revalidate=120",
    );
    response.headers_mut().insert(
        "x-pokoin-handler",
        "rust-search".parse().unwrap(),
    );
    response
}

struct Found {
    hits: Vec<Hit>,
    total: Option<i64>,
}

struct Hit {
    card_id: i64,
    weight: f64,
}

async fn redis_candidates(
    state: &AppState,
    query: &str,
    print_language: &str,
    limit: i64,
    offset: i64,
) -> Result<Found, redis::RedisError> {
    let Some(mut conn) = state.redis.read().await.clone() else {
        return Err(redis::RedisError::from((
            redis::ErrorKind::IoError,
            "redis is not configured",
        )));
    };
    let text = redis_search_query(query, print_language);
    if text.is_empty() {
        return Ok(Found { hits: Vec::new(), total: Some(0) });
    }
    let reply: redis::Value = redis::cmd("FT.SEARCH")
        .arg(&state.config.redis_index)
        .arg(text)
        .arg("LIMIT")
        .arg(offset.max(0))
        .arg(limit.clamp(1, 1000))
        .arg("RETURN")
        .arg(3)
        .arg("card_id")
        .arg("search_weight")
        .arg("effective_print_bucket")
        .arg("DIALECT")
        .arg(2)
        .arg("TIMEOUT")
        .arg(800)
        .query_async(&mut conn)
        .await?;
    let rows = match reply {
        redis::Value::Array(rows) => rows,
        _ => Vec::new(),
    };
    let total = redis_int(rows.first()).unwrap_or(0);
    let mut hits = Vec::new();
    let mut index = 1;
    while index + 1 < rows.len() {
        let fields = redis_pairs(&rows[index + 1]);
        if let Some(card_id) = fields.get("card_id").and_then(|value| value.parse().ok()) {
            hits.push(Hit {
                card_id,
                weight: fields
                    .get("search_weight")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0.0),
            });
        }
        index += 2;
    }
    Ok(Found { hits, total:Some(total) })
}

/// Candidate cap for a product-filtered page: one Redis call, then SQL.
const PRODUCT_CANDIDATES: i64 = 5000;

/// Every candidate for `query` with its relevance score, in one FT.SEARCH.
async fn redis_scored_candidates(state:&AppState,query:&str,print_language:&str,cap:i64)->Result<(Vec<(Hit,f64)>,i64),redis::RedisError>{
 let Some(mut conn)=state.redis.read().await.clone() else {
  return Err(redis::RedisError::from((redis::ErrorKind::IoError,"redis is not configured")));
 };
 let text=redis_search_query(query,print_language);
 if text.is_empty(){return Ok((Vec::new(),0))}
 let reply:redis::Value=redis::cmd("FT.SEARCH").arg(&state.config.redis_index).arg(text)
  .arg("WITHSCORES").arg("LIMIT").arg(0).arg(cap.clamp(1,10_000))
  .arg("RETURN").arg(2).arg("card_id").arg("search_weight")
  .arg("DIALECT").arg(2).arg("TIMEOUT").arg(1500)
  .query_async(&mut conn).await?;
 let rows=match reply {redis::Value::Array(rows)=>rows,_=>Vec::new()};
 let total=redis_int(rows.first()).unwrap_or(0);
 let mut hits=Vec::new();
 let mut index=1;
 // WITHSCORES: key, score, fields per document.
 while index+2<rows.len(){
  let score=match &rows[index+1]{
   redis::Value::BulkString(bytes)=>String::from_utf8_lossy(bytes).parse::<f64>().unwrap_or(0.0),
   redis::Value::Double(value)=>*value,
   redis::Value::SimpleString(text)=>text.parse::<f64>().unwrap_or(0.0),
   _=>0.0,
  };
  let fields=redis_pairs(&rows[index+2]);
  if let Some(card_id)=fields.get("card_id").and_then(|value|value.parse().ok()){
   let weight=fields.get("search_weight").and_then(|value|value.parse().ok()).unwrap_or(0.0);
   hits.push((Hit{card_id,weight},score));
  }
  index+=3;
 }
 Ok((hits,total))
}

/// Score desc, then card id: FT.SEARCH breaks score ties differently on each
/// call, so offset pages must be cut from one deterministic order (otherwise a
/// card can show on two pages while another never shows).
fn stable_candidate_order(hits:&mut [(Hit,f64)]){
 hits.sort_by(|a,b|b.1.total_cmp(&a.1).then(a.0.card_id.cmp(&b.0.card_id)));
}

// Product constraints apply before pagination. The current Redis schema has
// no product TAG, so read every candidate once, filter the ids in SQL, then page.
async fn filtered_candidates(state:&AppState,pool:&sqlx::PgPool,query:&str,print_language:&str,product:&str,limit:i64,offset:i64)->Result<Found,redis::RedisError>{
 if product.is_empty(){return redis_candidates(state,query,print_language,limit,offset).await}
 let (mut scored,redis_total)=redis_scored_candidates(state,query,print_language,PRODUCT_CANDIDATES).await?;
 let ids=scored.iter().map(|(hit,_)|hit.card_id).collect::<Vec<_>>();
 let allowed=sqlx::query_scalar::<_,i64>("select card_id from public.marketplace_search_candidates where card_id=any($1::bigint[]) and product_type=$2").bind(&ids).bind(product).fetch_all(pool).await.map_err(|_|redis::RedisError::from((redis::ErrorKind::IoError,"product filter database query failed")))?;
 let allowed:std::collections::HashSet<_>=allowed.into_iter().collect();
 let mut seen=std::collections::HashSet::new();
 scored.retain(|(hit,_)|allowed.contains(&hit.card_id)&&seen.insert(hit.card_id));
 stable_candidate_order(&mut scored);
 let total=if redis_total<=PRODUCT_CANDIDATES {Some(scored.len() as i64)} else {None};
 Ok(Found{hits:scored.into_iter().map(|(hit,_)|hit).skip(offset.max(0) as usize).take(limit as usize).collect(),total})
}

#[cfg(test)]
mod stable_order_tests {
 use super::*;
 #[test]
 fn ties_order_by_card_id_and_scores_stay_first(){
  let mut hits=vec![(Hit{card_id:9,weight:0.0},1.0),(Hit{card_id:3,weight:0.0},2.0),(Hit{card_id:5,weight:0.0},1.0),(Hit{card_id:1,weight:0.0},1.0)];
  stable_candidate_order(&mut hits);
  assert_eq!(hits.iter().map(|(h,_)|h.card_id).collect::<Vec<_>>(),vec![3,1,5,9]);
 }
}

fn rank_record(row:&serde_json::Value,weight:f64,order:usize)->SearchRow {
 use pokoin_catalog::card::{text,number};
 SearchRow{
  card_id:number(row,&["card_id"]) as i64,ct_id:Some(number(row,&["ct_id"]) as i64).filter(|i|*i>0),
  name:text(row,&["name"]),set_name:text(row,&["set_name"]),card_number:text(row,&["card_number"]),rarity:text(row,&["rarity"]),
  item_kind:text(row,&["item_kind"]),product_type:text(row,&["product_type"]),image_url:text(row,&["image_url"]),cdn_image_url:text(row,&["cdn_image_url"]),
  preview_image_url:text(row,&["preview_image_url"]),homepage_image_url:text(row,&["homepage_image_url"]),
  artist:text(row,&["artist"]),illustrator:text(row,&["illustrator"]),nationality:text(row,&["nationality"]),product_variant:text(row,&["product_variant"]),emoji:text(row,&["emoji"]),
  search_weight:weight,redis_order:order,price:Some(number(row,&["lowest_price_pkn"])).filter(|p|*p>0.),stock:number(row,&["listed_quantity"]) as i64,
  has_cardtrader:row["has_cardtrader_listing"].as_bool().unwrap_or(false),eligible_count:number(row,&["cardtrader_eligible_listing_count"]) as i64
 }
}

fn parse_limit(value: Option<&str>, fallback: i64, max: i64) -> i64 {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return fallback;
    };
    let Ok(limit) = raw.parse::<f64>() else {
        return fallback;
    };
    if !limit.is_finite() {
        return fallback;
    }
    (limit.trunc() as i64).clamp(1, max)
}

fn parse_offset(value: Option<&str>) -> i64 {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return 0;
    };
    let Ok(offset) = raw.parse::<f64>() else {
        return 0;
    };
    if !offset.is_finite() || offset < 0.0 {
        return 0;
    }
    (offset.trunc() as i64).min(10_000)
}


fn redis_int(value: Option<&redis::Value>) -> Option<i64> {
    match value {
        Some(redis::Value::Int(number)) => Some(*number),
        Some(redis::Value::BulkString(bytes)) => String::from_utf8_lossy(bytes).parse().ok(),
        _ => None,
    }
}

fn redis_string(value: &redis::Value) -> String {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        redis::Value::SimpleString(text) => text.clone(),
        redis::Value::Int(number) => number.to_string(),
        redis::Value::Double(number) => number.to_string(),
        _ => String::new(),
    }
}

fn redis_pairs(value: &redis::Value) -> HashMap<String, String> {
    let rows = match value {
        redis::Value::Array(rows) => rows,
        _ => return HashMap::new(),
    };
    let mut out = HashMap::new();
    let mut index = 0;
    while index + 1 < rows.len() {
        out.insert(redis_string(&rows[index]), redis_string(&rows[index + 1]));
        index += 2;
    }
    out
}

pub(crate) async fn sql_search_page(wanted:pokoin_api_common::compact::Wanted,pool:&sqlx::PgPool,query:&str,game:&str,product_type:&str,product_only:bool,lang:&str,limit:i64,offset:i64,include_facets:bool)->Response {
 let phrase=query.trim().to_lowercase();
 let like=format!("%{phrase}%");
 let pokemon=game=="pokemon";
 let sql=if pokemon {
 r#"select c.card_id from public.marketplace_search_candidates c
 where coalesce(c.cdn_image_url,c.preview_image_url,c.image_url) is not null
 and ($1='' or c.search_text ilike $2 or word_similarity($1,coalesce(c.set_name,''))>0.4 or word_similarity($1,coalesce(c.name,''))>0.4)
 and ($3='' or c.product_type=$3)
 and (not $4 or c.item_kind='product' or c.product_type='jumbo')
 order by case when lower(c.name)=$1 then 0 when lower(c.set_name)=$1 then 1 when lower(c.name) like $2 then 2 when lower(c.set_name) like $2 then 3 else 4 end,
 c.search_weight desc,c.card_id desc limit $5 offset $6"#
 } else {
 r#"select c.card_id from public.marketplace_search_candidates c
 where coalesce(c.cdn_image_url,c.preview_image_url,c.image_url) is not null
 and ($1='' or c.search_text like $2 or word_similarity($1,coalesce(c.set_name,''))>0.4 or word_similarity($1,coalesce(c.name,''))>0.4)
 and ($3='' or c.product_type=$3)
 and (not $4 or c.item_kind='product' or c.product_type='jumbo')
 and ($1<>'' or $3<>'' or $4 or (c.item_kind='single' and c.product_type='card'))
 order by case when lower(c.name)=$1 then 0 when lower(c.set_name)=$1 then 1 when lower(c.name) like $2 then 2 when lower(c.set_name) like $2 then 3 when word_similarity($1,coalesce(c.set_name,''))>0.4 then 4 when word_similarity($1,coalesce(c.name,''))>0.4 then 5 else 6 end,
 case when not $4 and $3<>'sealed' and c.item_kind='single' then 0 else 1 end,c.search_weight desc,c.imported_at desc nulls last,c.card_id desc limit $5 offset $6"#
 };
 let ids=match sqlx::query_scalar::<_,i64>(sql).bind(&phrase).bind(like).bind(product_type).bind(product_only).bind(limit+1).bind(offset).fetch_all(pool).await {Ok(r)=>r,Err(e)=>return crate::catalog_api::failure(&e)};
 let has_more=ids.len()>limit as usize;
 let mut raw=match crate::catalog_api::cards(pool,&ids[..ids.len().min(limit as usize)],game).await {Ok(r)=>r,Err(e)=>return crate::catalog_api::failure(&e)};
 if let Err(e)=crate::catalog_api::localize(pool,&mut raw,lang,game).await{return crate::catalog_api::failure(&e)}
 let cards=raw.iter().map(pokoin_catalog::react_record).collect::<Vec<_>>();
 let mut body=page_body(query,game,product_type,product_only,lang,limit,offset,None,cards);
 body["hasMore"]=json!(has_more);
 if include_facets && pokemon {
  match facets(pool,query,lang).await {Ok(r)=>body["facets"]["products"]=json!(r),Err(e)=>return crate::catalog_api::failure(&e)}
 }
 crate::catalog_api::response_c1(wanted,StatusCode::OK,body,"public, max-age=15, s-maxage=60, stale-while-revalidate=120")
}
fn facet_terms(query:&str)->Vec<String>{
 query.chars().take(120).collect::<String>().to_lowercase().split(|c:char|!c.is_ascii_alphanumeric())
 .filter(|s|!s.is_empty() && (s.len()>=2 || s.chars().all(|c|c.is_ascii_digit())))
 .map(|s|format!("%{s}%")).collect()
}
async fn facets(pool:&sqlx::PgPool,query:&str,lang:&str)->Result<Vec<serde_json::Value>,sqlx::Error>{
 let terms=facet_terms(query);
 let fields=["name","set_name","trainer_name","card_type","rarity","card_number","product_variant"];
 // Bind each term in a fixed OR predicate. A correlated unnest anti-join forced
 // a full catalog scan and repeated translation scans for every candidate.
 let clauses=terms.iter().enumerate().map(|(i,_)|{
  let pattern=2*i+1;let language=2*i+2;
  let mut tests=fields.iter().map(|f|format!("c.{f} ilike ${pattern}")).collect::<Vec<_>>();
  tests.push(format!("c.name in (select t.name from public.marketplace_card_name_translations t where t.language=${language} and t.localized_name ilike ${pattern})"));
  format!("({})",tests.join(" or "))
 }).collect::<Vec<_>>();
 let predicate=if clauses.is_empty(){String::new()}else{format!(" and {}",clauses.join(" and "))};
 let sql=format!(r#"with product_facets as (
 select case when c.item_kind='product' then coalesce(nullif(c.product_type,''),'sealed_product') else 'card' end product_type,count(*)::bigint count
 from public.marketplace_search_candidates c
 where coalesce(c.preview_image_url,c.cdn_image_url,c.image_url) is not null {predicate}
 group by 1)
 select product_type,count from product_facets order by case when product_type='card' then 0 when product_type='booster_box' then 10 when product_type='booster_pack' then 20 else 100 end,count desc,product_type asc"#);
 let mut q=sqlx::query_as::<_,(String,i64)>(&sql);
 for term in &terms {q=q.bind(term).bind(lang);}
 let rows=q.fetch_all(pool).await?;
 Ok(rows.into_iter().map(|(product,count)|json!({"productType":product,"count":count})).collect())
}
#[cfg(test)]mod facet_tests{
 use super::*;
 #[test]fn catalog_names_and_set_codes_keep_final_s(){
  assert_eq!(facet_terms("Gyarados HGSS Tauros"),vec!["%gyarados%","%hgss%","%tauros%"]);
  assert_eq!(facet_terms("Misty's 061"),vec!["%misty%","%061%"]);
 }
}
