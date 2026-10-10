//! Native catalog lookups. All SQL clauses are fixed here; client values are bound.
use std::collections::HashMap;
use axum::{extract::State,http::{HeaderMap,StatusCode},response::{IntoResponse,Response}};
use serde_json::{json,Value};
use sqlx::PgPool;
use pokoin_catalog::card::{text,number};
use pokoin_api_common::compact::{self,Wanted};
use crate::{AppState,suggest::{cors,game_from}};

pub fn params(uri:&axum::http::Uri)->HashMap<String,String>{
 serde_urlencoded::from_str(uri.query().unwrap_or("")).unwrap_or_default()
}
pub fn positive_id(s:&str)->Option<i64>{
 if s.is_empty() || !s.bytes().all(|b|b.is_ascii_digit()){return None}
 s.parse::<i64>().ok().filter(|i|*i>0 && *i<=9_007_199_254_740_991)
}
pub fn limit(p:&HashMap<String,String>,key:&str,default:i64,max:i64)->i64{
 p.get(key).and_then(|v|v.trim().parse::<f64>().ok()).filter(|v|v.is_finite()).map(|v|(v.trunc() as i64).clamp(1,max)).unwrap_or(default)
}
pub fn response(status:StatusCode,body:Value,cache:&str)->Response{
 let bytes=pokoin_api_common::stages::timed_sync(pokoin_api_common::stages::SERIALIZE,||serde_json::to_vec(&body).unwrap_or_default());
 cors(status,if cache.is_empty(){None}else{Some(cache.to_owned())},Some("application/json; charset=utf-8"),bytes).into_response()
}
/// `response` in whichever representation the request asked for. The default
/// representation is byte-identical to [`response`]; both carry `Vary: Accept`
/// so a shared cache keeps the two apart.
pub fn response_c1(wanted:Wanted,status:StatusCode,body:Value,cache:&str)->Response{
 let (content_type,bytes)=pokoin_api_common::stages::timed_sync(pokoin_api_common::stages::SERIALIZE,||if wanted.c1(){
  (compact::C1_CONTENT_TYPE,compact::encode::encode_to_vec_with(&body,wanted.encode_options()))
 }else{
  ("application/json; charset=utf-8",serde_json::to_vec(&body).unwrap_or_default())
 });
 let mut response=cors(status,if cache.is_empty(){None}else{Some(cache.to_owned())},Some(content_type),bytes).into_response();
 response.headers_mut().insert(axum::http::header::VARY,axum::http::HeaderValue::from_static("Accept"));
 if wanted.c1(){response.headers_mut().insert(compact::C1_FORMAT_HEADER.0,axum::http::HeaderValue::from_static(compact::C1_FORMAT_HEADER.1));}
 response
}
/// What the request asked for, from its `Accept` header and `?format=`.
pub fn wanted(headers:&HeaderMap,uri:&axum::http::Uri)->Wanted{
 Wanted::from_request(headers,&pokoin_api_common::http::Query::from_uri(uri))
}
pub fn failure(error:&sqlx::Error)->Response {
 tracing::error!(%error,"catalog query failed");
 response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Marketplace catalog temporarily unavailable."}),"no-store")
}
pub async fn game_pool(state:&AppState,game:&str)->Option<PgPool>{
 if game=="pokemon"{return state.db.read().await.clone()}
 if let Some(pool)=state.game_dbs.read().await.get(game).cloned(){return Some(pool)}
 let env_name=format!("{}_MARKETPLACE_DATABASE_URL",game.to_ascii_uppercase().replace('-',
 "_"));
 let url=std::env::var(&env_name).ok().filter(|s|!s.trim().is_empty())?;
 let pool=sqlx::postgres::PgPoolOptions::new().max_connections(state.config.db_pool_max).acquire_timeout(std::time::Duration::from_secs(3)).connect_lazy(&url).ok()?;
 let mut map=state.game_dbs.write().await;
 Some(map.entry(game.to_owned()).or_insert(pool).clone())
}
// JSON projections tolerate satellite catalogs without Pokemon-only columns.
// Price preference is explicit and deterministic: cheapest provider wins.
pub async fn cards(pool:&PgPool,ids:&[i64],game:&str)->Result<Vec<Value>,sqlx::Error>{
 if ids.is_empty(){return Ok(vec![])}
 let rows=sqlx::query_scalar::<_,sqlx::types::Json<Value>>(r#"
 select to_jsonb(c) || jsonb_build_object('canonical_path',coalesce(u.canonical_path,'')) as card
 from public.marketplace_search_candidates c
 left join lateral (select canonical_path from public.marketplace_card_urls where card_id=c.card_id and language='en' order by canonical_path limit 1) u on true
 where c.card_id=any($1::bigint[])"#).bind(ids).fetch_all(pool).await?;
 let mut rows=rows.into_iter().map(|r|r.0).collect::<Vec<_>>();
 if game=="pokemon"{
  let ct_ids=rows.iter().filter_map(|r|positive_id(&text(r,&["ct_id"]))).collect::<Vec<_>>();
  let public_ids=ids.iter().map(i64::to_string).collect::<Vec<_>>();
  let (prices,shades,themes)=tokio::join!(
   sqlx::query_scalar::<_,sqlx::types::Json<Value>>(r#"select to_jsonb(p) from public.cheapest_homepage_cache_blueprint p
    where provider in ('cardtrader','pokoin_native') and cheapest_price_pkn>0 and eligible_listing_count>0
    and (blueprint_id=any($1::bigint[]) or pokoin_card_id=any($2::text[]))
    order by cheapest_price_pkn,provider"#).bind(&ct_ids).bind(&public_ids).fetch_all(pool),
   optional_rows(pool,"marketplace_leftover_art_shades","select to_jsonb(s) from public.marketplace_leftover_art_shades s where ct_id=any($1::bigint[])",&ct_ids),
   optional_rows(pool,"marketplace_leftover_visual_themes","select to_jsonb(t) from public.marketplace_leftover_visual_themes t where ct_id=any($1::bigint[])",&ct_ids)
  );
  let mut by_public=HashMap::new();let mut by_ct=HashMap::new();
  for r in prices?{let r=r.0;
   let public=text(&r,&["pokoin_card_id"]);let ct=text(&r,&["blueprint_id"]);
   if !public.is_empty(){by_public.entry(public).or_insert_with(||r.clone());}
   if !ct.is_empty(){by_ct.entry(ct).or_insert(r);}
  }
  let shades:HashMap<_,_>=shades?.into_iter().map(|r|(text(&r,&["ct_id"]),r)).collect();
  let themes:HashMap<_,_>=themes?.into_iter().map(|r|(text(&r,&["ct_id"]),r)).collect();
  for row in &mut rows{
   let id=text(row,&["card_id"]);let ct=text(row,&["ct_id"]);
   if let Some(price)=by_public.get(&id).or_else(||by_ct.get(&ct)){
    let stock=number(price,&["eligible_quantity","eligible_listing_count"]);
    let has_ct=text(price,&["provider"])=="cardtrader";
    row["lowest_price_pkn"]=price["cheapest_price_pkn"].clone();row["listed_quantity"]=json!(stock);
    row["has_cardtrader_listing"]=json!(has_ct);
    row["cardtrader_eligible_listing_count"]=json!(if has_ct{stock}else{0.});
   }
   if let Some(shade)=shades.get(&ct){
    row["art_shade"]=shade["shade"].clone();
    row["current_artwork_identity"]=json!(text(shade,&["artwork_identity"]));
   }
   row["visual_theme_row"]=themes.get(&ct).cloned().unwrap_or(Value::Null);
  }
 }
 let mut by_id:HashMap<i64,Value>=rows.into_iter().filter_map(|r|Some((positive_id(&text(&r,&["card_id"]))?,r))).collect();
 Ok(ids.iter().filter_map(|id|by_id.remove(id)).collect())
}
async fn optional_rows(pool:&PgPool,table:&str,sql:&str,ids:&[i64])->Result<Vec<Value>,sqlx::Error>{
 use std::{sync::{Mutex,OnceLock},time::{Duration,Instant}};
 type Tables=HashMap<String,(Instant,bool)>;
 static TABLES:OnceLock<Mutex<Tables>>=OnceLock::new();
 let options=pool.connect_options();
 let key=format!("{}:{}:{}:{table}",options.get_host(),options.get_port(),options.get_database().unwrap_or(""));
 let cached=TABLES.get_or_init(||Mutex::new(HashMap::new())).lock().unwrap().get(&key).copied();
 let present=if let Some((_,present))=cached.filter(|(at,_)|at.elapsed()<Duration::from_secs(300)){present}else{
  let present=sqlx::query_scalar::<_,bool>("select to_regclass($1) is not null").bind(format!("public.{table}")).fetch_one(pool).await?;
  TABLES.get().unwrap().lock().unwrap().insert(key.clone(),(Instant::now(),present));present
 };
 if !present{return Ok(vec![])}
 match sqlx::query_scalar::<_,sqlx::types::Json<Value>>(sql).bind(ids).fetch_all(pool).await {
  Ok(rows)=>Ok(rows.into_iter().map(|r|r.0).collect()),
  Err(error) if error.as_database_error().is_some_and(|e|e.code().as_deref()==Some("42P01"))=>{
   TABLES.get().unwrap().lock().unwrap().insert(key,(Instant::now(),false));Ok(vec![])
  },
  Err(error)=>Err(error)
 }
}
pub async fn card_tiles(State(state):State<AppState>,headers:HeaderMap,uri:axum::http::Uri)->Response{

 let p=params(&uri);let game=game_from(&headers,p.get("game").map(String::as_str));
 let mut seen=std::collections::HashSet::new();
 let ids=p.get("ids").map(String::as_str).unwrap_or("").split(',').filter_map(|s|positive_id(s.trim())).filter(|id|seen.insert(*id)).take(80).collect::<Vec<_>>();
 if ids.is_empty(){return response(StatusCode::OK,json!({"source":"pi","cards":[]}),"public, max-age=30, s-maxage=120")}
 let Some(pool)=game_pool(&state,&game).await else{return response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Marketplace database unavailable."}),"no-store")};
 // Only the Pokemon database has a tile read model; other games answer empty.
 let rows=match optional_rows(&pool,"marketplace_card_tiles","select payload from public.marketplace_card_tiles where card_id=any($1::bigint[]::text[])",&ids).await{Ok(r)=>r,Err(e)=>return failure(&e)};
 let meta=match cards(&pool,&ids,&game).await{Ok(r)=>r,Err(e)=>return failure(&e)};
 let packs:HashMap<_,_>=meta.iter().filter_map(|r|{
  let theme=crate::visual_theme::visual_theme(r.get("visual_theme_row").unwrap_or(&Value::Null),&text(r,&["art_shade"]),&text(r,&["current_artwork_identity"]));
  crate::visual_theme::pack_visual_theme(&theme).map(|pack|(text(r,&["card_id"]),pack))
 }).collect();
 let by_id:HashMap<_,_>=rows.into_iter().map(|r|{
  let row=r;let mut card=pokoin_catalog::react_record(&row);
  if let Some(day)=row.get("salesDay").and_then(Value::as_str).filter(|s|!s.is_empty()){
   card["salesDay"]=json!(day);
   for key in ["dailySoldQty","dailySaleSamples"]{card[key]=json!(number(&row,&[key]));}
   for key in ["dailyMedianPkn","dailyMinPkn","dailyMaxPkn"]{let n=number(&row,&[key]);card[key]=if n==0.{Value::Null}else{json!(n)};}
  }
  let id=text(&card,&["id"]);if let Some(pack)=packs.get(&id){card["vt"]=json!(pack)}
  (id,card)
 }).collect();
 response(StatusCode::OK,json!({"source":"pi","cards":ids.iter().filter_map(|id|by_id.get(&id.to_string())).collect::<Vec<_>>()}),"public, max-age=30, s-maxage=120")
}
pub async fn card_page(State(state):State<AppState>,headers:HeaderMap,uri:axum::http::Uri)->Response{

 let p=params(&uri);let game=game_from(&headers,p.get("game").map(String::as_str));
 let Some(id)=positive_id(p.get("cardId").or_else(||p.get("id")).map(String::as_str).unwrap_or("")) else{return response(StatusCode::BAD_REQUEST,json!({"error":"cardId is required (public marketplace id)."}),"")};
 let Some(pool)=game_pool(&state,&game).await else{return response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Marketplace database unavailable."}),"no-store")};
 use pokoin_api_common::stages::{timed,SQL};
 let primary=match timed(SQL,cards(&pool,&[id],&game)).await{Ok(mut r)=>match r.pop(){Some(r)=>r,None=>return response(StatusCode::NOT_FOUND,json!({"error":"Card not found.","cardId":id.to_string()}),"")},Err(e)=>return failure(&e)};
 let name=text(&primary,&["name"]);let set=text(&primary,&["set_name"]);
 let version=text(&primary,&["version"]);
 // `related` rides along: one primary-key read of the prebuilt neighbours.
 let ((version_ids,rarity_ids,neighbors,meta),related)=tokio::join!(
  timed(SQL,async{tokio::join!(
   version_ids(&pool,id,&name,&set,&version,&game),
   name_set_ids(&pool,&name,&set,24),
   neighbors(&pool,&set,id,6),
   version_meta(&pool,id,&game)
  )}),
  crate::related::for_card_page(&pool,id,&game)
 );
 let version_ids=match version_ids{Ok(r)=>r,Err(e)=>return failure(&e)};
 let rarity_ids=match rarity_ids{Ok(mut r)=>{if r.is_empty(){r.push(id)}r},Err(e)=>return failure(&e)};
 let neighbors=match neighbors{Ok(r)=>r,Err(e)=>return failure(&e)};
 let meta=match meta{Ok(r)=>r,Err(e)=>return failure(&e)};
 let mut wanted=version_ids.clone();wanted.extend(&rarity_ids);wanted.extend(neighbors.iter().map(|(id,_,_)|*id));wanted.sort_unstable();wanted.dedup();
 let packed=match timed(SQL,cards(&pool,&wanted,&game)).await{Ok(r)=>r,Err(e)=>return failure(&e)};
 let map:HashMap<i64,Value>=packed.into_iter().filter_map(|r|Some((positive_id(&text(&r,&["card_id"]))?,pokoin_catalog::react_record(&r)))).collect();
 let mut card=pokoin_catalog::react_record(&primary);
 let version_count=meta.as_ref().map(|m|number(m,&["member_count"]) as usize).filter(|n|*n>0).unwrap_or(version_ids.len());
 card["versionCount"]=json!(version_count);
 let version=meta.as_ref().map(|m|text(m,&["version"])).filter(|v|!v.is_empty()).unwrap_or(version);
 card["version"]=json!(version);
 let versions=version_ids.iter().filter_map(|i|map.get(i).cloned()).collect::<Vec<_>>();
 let rarities=rarity_ids.iter().filter_map(|i|map.get(i).cloned()).collect::<Vec<_>>();
 let mut prev=neighbors.iter().filter(|(_,_,d)|*d<=6).map(|(id,_,d)|(*d,*id)).collect::<Vec<_>>();prev.sort_unstable();
 let mut next=neighbors.iter().filter(|(_,d,_)|*d<=6).map(|(id,d,_)|(*d,*id)).collect::<Vec<_>>();next.sort_unstable();
 let lang=p.get("lang").or_else(||p.get("language")).or_else(||p.get("search_language")).map(String::as_str).unwrap_or("en");
 let slug=p.get("cardSlug").or_else(||p.get("slug")).map(String::as_str).unwrap_or("");
 let cheapest=if card["price"].is_null(){Value::Null}else{json!({"cardId":id.to_string(),"pricePkn":card["price"],"available":true,"cardtrader":{"available":card["hasCardTraderListing"]}})};
 let requested = |key: &str| p.get(key).is_some_and(|v| ["1", "true", "yes"].contains(&v.trim().to_lowercase().as_str()));
 let offers = if requested("includeOffers") {
  let Some(commerce) = state.commerce.read().await.clone() else { return response(StatusCode::SERVICE_UNAVAILABLE,json!({"error":"Service temporarily unavailable."}),"no-store") };
  let native_only = !requested("liveOffers");
  let budget = std::time::Duration::from_millis(if native_only {800} else {8000});
  match tokio::time::timeout(budget,pokoin_commerce::handlers::listings::read_public_offers_for_card(&commerce,&id.to_string(),limit(&p,"offerLimit",40,80),&game,native_only)).await {
   Ok(Ok(rows))=>rows,
   Ok(Err(e))=>{tracing::warn!(card_id=id,error=%e,"card offers fallback");vec![]},
   Err(_)=>{tracing::warn!(card_id=id,"card offers timeout fallback");vec![]},
  }
 } else {vec![]};
 let sales = if requested("includeSales") {
  let slice = pokoin_catalog_api::sales::core::SoldSlice::default();
  let mut rows = match pokoin_catalog_api::sales::core::read_oracle_card_sales(&pool,id,limit(&p,"salesLimit",40,120),&slice).await {Ok(r)=>r,Err(e)=>return failure(&e)};
  rows.sort_by_key(|r|text(r,&["soldAt"]));rows
 } else {vec![]};
 let same_as = if requested("includeSameAs") {
  let args = pokoin_catalog_api::shared::card_versions::RowsForVersionsArgs {query:String::new(),expansion_name:String::new(),card_id:String::new(),card_slug:String::new(),same_as_card_id:id.to_string(),limit:24,product_type:text(&card,&["productType"]),product_category:String::new(),search_language:"en".into()};
  match pokoin_catalog_api::shared::card_versions::rows_for_versions(&pool,&args).await {Ok(rows)=>rows.iter().map(pokoin_catalog::react_record).filter(|r|text(r,&["id"])!=id.to_string()).collect::<Vec<_>>(),Err(e)=>return failure(&e)}
 } else {vec![]};
 let path=text(&card,&["canonicalPath"]);
 let title=[text(&card,&["name"]),text(&card,&["set"]),text(&card,&["number"])].into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" ");
 let description=[text(&card,&["name"]),text(&card,&["rarity"]),text(&card,&["number"]),text(&card,&["set"])].into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" · ");
 let theme=crate::visual_theme::visual_theme(primary.get("visual_theme_row").unwrap_or(&Value::Null),&text(&primary,&["art_shade"]),&text(&primary,&["current_artwork_identity"]));
 response(StatusCode::OK,json!({
  "card":card,"game":game,"version":version,"visualTheme":theme,"versions":versions,"rarities":rarities,"versionCount":version_count,
  "sameAs":same_as,"neighbors":{"prev":prev.iter().filter_map(|(_,id)|map.get(id)).collect::<Vec<_>>(),"next":next.iter().filter_map(|(_,id)|map.get(id)).collect::<Vec<_>>()},
  "offers":offers,"sales":sales,"cheapest":cheapest,"artist":{"name":card["artist"],"illustrator":card["illustrator"]},
  "canonicalPath":path,"seo":{"title":format!("{title} Price & Cards for Sale | Pokoin"),"description":description,"imageUrl":card["heroImageUrl"],"canonicalPath":path},
  "lookup":{"cardId":id.to_string(),"lang":lang,"slug":slug},
  "related":related
 }),"public, max-age=10, s-maxage=30, stale-while-revalidate=60")
}
async fn name_set_ids(pool:&PgPool,name:&str,set:&str,cap:i64)->Result<Vec<i64>,sqlx::Error>{
 sqlx::query_scalar("select card_id from public.marketplace_search_candidates where item_kind='single' and product_type='card' and name=$1 and set_name=$2 and coalesce(cdn_image_url,image_url) is not null order by card_id desc limit $3")
 .bind(name).bind(set).bind(cap).fetch_all(pool).await
}
async fn version_ids(pool:&PgPool,id:i64,name:&str,set:&str,version:&str,game:&str)->Result<Vec<i64>,sqlx::Error>{
 if game=="pokemon" && !version.is_empty(){
  let ids=sqlx::query_scalar::<_,i64>("select card_id from public.marketplace_search_candidates where item_kind='single' and product_type='card' and version=(select version from public.marketplace_search_candidates where card_id=$1) order by card_id limit 64").bind(id).fetch_all(pool).await?;
  if !ids.is_empty(){return Ok(ids)}
 }
 let mut ids=name_set_ids(pool,name,set,48).await?;if ids.is_empty(){ids.push(id)}Ok(ids)
}
async fn version_meta(pool:&PgPool,id:i64,game:&str)->Result<Option<Value>,sqlx::Error>{
 if game!="pokemon"{return Ok(None)}
 Ok(sqlx::query_scalar::<_,sqlx::types::Json<Value>>("select jsonb_build_object('version',s.version,'member_count',s.member_count) from public.marketplace_search_candidates c join public.pokoin_version_sets s on s.version=c.version where c.card_id=$1 limit 1").bind(id).fetch_optional(pool).await?.map(|r|r.0))
}
async fn neighbors(pool:&PgPool,set:&str,id:i64,radius:i64)->Result<Vec<(i64,i64,i64)>,sqlx::Error>{
 // Stored set position (scripts/sql/113_set_order.sql, refreshed by the
 // build-lists job): natural collector order, so SL3 no longer sits between
 // 3/95 and 4/95. Rows not ranked yet (0) go last until the next refresh.
 sqlx::query_as(r#"with ordered as (
 select card_id,row_number() over(order by set_order=0,set_order,card_id) rn,count(*) over() n
 from public.marketplace_search_candidates where item_kind='single' and product_type='card' and set_name=$1 and coalesce(cdn_image_url,image_url) is not null),
 cur as(select card_id,rn,n from ordered where card_id=$2)
 select o.card_id,((o.rn-cur.rn+cur.n)%cur.n)::bigint,((cur.rn-o.rn+cur.n)%cur.n)::bigint
 from ordered o cross join cur where o.card_id<>cur.card_id and (((o.rn-cur.rn+cur.n)%cur.n) between 1 and $3 or ((cur.rn-o.rn+cur.n)%cur.n) between 1 and $3)"#).bind(set).bind(id).bind(radius).fetch_all(pool).await
}
#[cfg(test)] mod tests {
 use super::*;
 #[test]fn unsafe_and_partial_ids_are_rejected(){for s in ["","0","-1","12abc","1.0","9007199254740992"]{assert_eq!(positive_id(s),None)}assert_eq!(positive_id("693360"),Some(693360))}
}

pub async fn localize(pool:&PgPool,rows:&mut [Value],lang:&str,game:&str)->Result<(),sqlx::Error>{
 if game!="pokemon" || lang.eq_ignore_ascii_case("en"){return Ok(())}
 let lang=match lang.to_lowercase().as_str(){"ja"=>"jp","zh-cn"|"zh-hans"=>"zh","zh-tw"|"zh-hant"=>"zht",x=>x}.to_owned();
 let names=rows.iter().map(|r|text(r,&["name"])).collect::<Vec<_>>();
 let sets=rows.iter().map(|r|text(r,&["set_name","set"])).collect::<Vec<_>>();
 let rarities=rows.iter().map(|r|text(r,&["rarity"])).collect::<Vec<_>>();
 let (n,s,r)=tokio::join!(
 sqlx::query_as::<_,(String,String)>("select lower(name),localized_name from public.card_name_languages where language=$1 and name=any($2::text[])").bind(&lang).bind(&names).fetch_all(pool),
 sqlx::query_as::<_,(String,String)>("select lower(e.name),l.localized_name from public.expansion_languages l join public.pokoin_pokemon_expansions e on e.expansion_id=l.expansion_id where l.language=$1 and e.name=any($2::text[])").bind(&lang).bind(&sets).fetch_all(pool),
 sqlx::query_as::<_,(String,String)>("select lower(rarity),localized_name from public.rarity_languages where language=$1 and rarity=any($2::text[])").bind(&lang).bind(&rarities).fetch_all(pool)
 );
 let n:HashMap<_,_>=n?.into_iter().collect();let s:HashMap<_,_>=s?.into_iter().collect();let r:HashMap<_,_>=r?.into_iter().collect();
 for row in rows{
  for (target,key,map) in [("localized_name","name",&n),("localized_set","set_name",&s),("localized_rarity","rarity",&r)]{
   if let Some(v)=map.get(&text(row,&[key]).to_lowercase()).filter(|v|!v.is_empty()){row[target]=json!(v)}
  }
 }
 Ok(())
}
