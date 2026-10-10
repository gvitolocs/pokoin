//! Public read models only. Payloads are isolated from the retired reference runtime.
use std::{collections::HashMap,sync::{Arc,Weak},time::{Duration,Instant}};
use axum::{body::{Body,to_bytes},extract::{Request,State},http::{HeaderMap,StatusCode},middleware::Next,response::Response};
use serde_json::Value;
use sha2::{Digest,Sha256};
use tokio::sync::Mutex;
use crate::{AppState,catalog_api,suggest::game_from};
type Flight = Mutex<Option<Snapshot>>;
#[derive(Clone)]
struct Snapshot { body: Vec<u8>, headers: HeaderMap, at: Instant }
#[derive(Default)]
pub struct Coordinator { flights: Mutex<HashMap<String,Weak<Flight>>> }
struct Identity { key: String, generation: String, ttl: u64 }
/// Routes that can answer in the compact (`c1`) representation cache each
/// representation under its own key — otherwise a cached `c1` body would be
/// handed to a client that asked for plain JSON.
fn representation(req:&Request)->&'static str{
 if req.uri().path()!="/api/marketplace-search-page"{return ""}
 let query=pokoin_api_common::http::Query::parse(req.uri().query().unwrap_or(""));
 let wanted=pokoin_api_common::compact::Wanted::from_request(req.headers(),&query);
 if wanted.templates(){":c1v2"}else if wanted.c1(){":c1"}else{""}
}
fn digest(s:&str)->String { hex::encode(&Sha256::digest(s.as_bytes())[..8]) }
fn truth(s:Option<&str>)->bool{s.is_some_and(|s|["1","true","yes"].contains(&s.trim().to_ascii_lowercase().as_str()))}
fn identity(req:&Request)->Option<Identity>{
 if req.method()!=axum::http::Method::GET{return None}
 let pairs:Vec<(String,String)>=serde_urlencoded::from_str(req.uri().query().unwrap_or("")).unwrap_or_default();
 let first=|k:&str|pairs.iter().find(|(key,_)|key==k).map(|(_,v)|v.as_str());
 let path=req.uri().path();
 let (key,generation,echo,ttl)=if path=="/api/marketplace-search-page" {
  let game=game_from(req.headers(),first("game").or_else(||first("marketplaceGame")));
  let query=pokoin_search::clean_text(first("query").or_else(||first("q")).unwrap_or(""),180);
  let lang=pokoin_search::clean_text(first("search_language").or_else(||first("lang")).or_else(||first("language")).unwrap_or("en"),12);
  let lang=if lang.is_empty(){"en".into()}else{lang};
  let product=pokoin_search::clean_text(first("productType").unwrap_or(""),60);
  let print=pokoin_search::clean_print_language(first("print_language").or_else(||first("printLanguage")).unwrap_or("all"));
  let limit=first("limit").and_then(|s|s.trim().parse::<f64>().ok()).filter(|n|n.is_finite()).map(|n|(n.trunc() as i64).clamp(1,100)).unwrap_or(100);
  let offset=first("offset").and_then(|s|s.trim().parse::<f64>().ok()).filter(|n|n.is_finite() && *n>=0.).map(|n|(n.trunc() as i64).min(10000)).unwrap_or(0);
  let key=pokoin_cache::search_page_key(&game,&query,&lang,limit,offset,&product,&print,first("productSearchOnly")==Some("1"),first("includeFacets")!=Some("0"));
  (key,format!("pokoin:marketplace:v1:gen:search:{game}"),format!("{query}\n{lang}"),60)
 } else if path=="/api/marketplace-card-page" {
  // Card handler resolves duplicate parameters to the last value.
  let p:HashMap<_,_>=pairs.into_iter().collect();
  let get=|k:&str|p.get(k).map(String::as_str);
  let game=game_from(req.headers(),get("game"));
  let id=catalog_api::positive_id(get("cardId").or_else(||get("id")).unwrap_or(""))?.to_string();
  let lang=get("lang").or_else(||get("language")).or_else(||get("search_language")).unwrap_or("en");
  let slug=get("cardSlug").or_else(||get("slug")).unwrap_or("");
  let key=pokoin_cache::card_page_key(&game,&id,lang,truth(get("includeOffers")),truth(get("includeSales")),truth(get("includeSameAs")),truth(get("liveOffers")),catalog_api::limit(&p,"offerLimit",40,80),catalog_api::limit(&p,"salesLimit",40,120),slug);
  (key,pokoin_cache::card_generation_key(&game,&id),lang.to_owned(),30)
 } else {return None};
 if key.is_empty(){return None}
 Some(Identity{key:format!("pokoin:rust:read:v1:{key}:{}{}",digest(&echo),representation(req)),generation,ttl})
}
async fn get(conn:&mut redis::aio::ConnectionManager,key:&str)->Result<Option<Vec<u8>>,()>{
 tokio::time::timeout(Duration::from_millis(180),redis::cmd("GET").arg(key).query_async::<Option<Vec<u8>>>(conn)).await.map_err(|_|())?.map_err(|_|())
}
fn response(body:Vec<u8>,headers:HeaderMap,kind:&'static str)->Response {
 let mut r=Response::new(Body::from(body));*r.status_mut()=StatusCode::OK;*r.headers_mut()=headers;
 r.headers_mut().insert("x-pokoin-read-cache",kind.parse().unwrap());r
}
pub async fn read_cache(State(state):State<AppState>,req:Request,next:Next)->Response{
 let expected=crate::card_identity::expected(&req);
 let Some(id)=identity(&req) else{return next.run(req).await};
 let mut conn=state.redis.read().await.clone();
 let generation=if let Some(c)=conn.as_mut(){match get(c,&id.generation).await {
  Ok(raw)=>raw.and_then(|b|String::from_utf8(b).ok()).unwrap_or_else(||"0".into()),
  Err(_)=>return next.run(req).await,
 }}else{"0".into()};
 let key=format!("{}:{}:{}",id.key,state.config.release,digest(&generation));
 if let Some(c)=conn.as_mut(){
  if let Ok(Some(raw))=get(c,&key).await {
   if let Ok(v)=serde_json::from_slice::<Value>(&raw){
    if let (Some(body),Some(headers))=(v.get("body").and_then(Value::as_str),v.get("headers").and_then(Value::as_object)){
     let mut map=HeaderMap::new();for (k,v) in headers{if let (Ok(k),Some(v))=(axum::http::HeaderName::from_bytes(k.as_bytes()),v.as_str()){if let Ok(v)=v.parse(){map.insert(k,v);}}}
     if expected.as_ref().is_none_or(|(id,game)|crate::card_identity::matches(body.as_bytes(),id,game)){
      return response(body.as_bytes().to_vec(),map,"hit")
     }
     tracing::error!(card_id=?expected,code="card_identity_mismatch","cached catalog response discarded");
     let _=tokio::time::timeout(Duration::from_millis(180),redis::cmd("DEL").arg(&key).query_async::<u64>(c)).await;
    }
   }
  }
 }
 let flight={
  let mut map=state.read_cache.flights.lock().await;
  if map.len()>1024 {map.retain(|_,v|v.strong_count()>0);}
  if let Some(f)=map.get(&key).and_then(Weak::upgrade){f}else{let f=Arc::new(Mutex::new(None));map.insert(key.clone(),Arc::downgrade(&f));f}
 };
 let mut guard=flight.lock().await;
 if let Some(v)=guard.as_ref().filter(|v|v.at.elapsed()<Duration::from_secs(3)){return response(v.body.clone(),v.headers.clone(),"coalesced")}
 let result=next.run(req).await;
 if result.status()!=StatusCode::OK {return result}
 let (parts,body)=result.into_parts();
 let raw=match to_bytes(body,5*1024*1024).await {Ok(b)=>b.to_vec(),Err(e)=>{
  tracing::error!(error=%e,"read_model_body_limit");
  return catalog_api::response(StatusCode::INTERNAL_SERVER_ERROR,serde_json::json!({"error":"Read model response exceeded its size limit."}),"no-store")
 }};
 if expected.as_ref().is_some_and(|(id,game)|!crate::card_identity::matches(&raw,id,game)){
  tracing::error!(card_id=?expected,code="card_identity_mismatch","catalog response rejected before caching");
  return catalog_api::response(StatusCode::BAD_GATEWAY,serde_json::json!({"error":"Card response identity did not match the requested card.","code":"card_identity_mismatch"}),"no-store")
 }
 let headers=parts.headers.clone();
 *guard=Some(Snapshot{body:raw.clone(),headers:headers.clone(),at:Instant::now()});
 if let Some(c)=conn.as_mut(){
  // Persist only public body and response headers, never request credentials.
  let safe:serde_json::Map<String,Value>=headers.iter().filter(|(k,_)|!["set-cookie","x-request-id"].contains(&k.as_str())).filter_map(|(k,v)|Some((k.to_string(),Value::String(v.to_str().ok()?.into())))).collect();
  if let Ok(body)=std::str::from_utf8(&raw){
   let payload=serde_json::json!({"body":body,"headers":safe}).to_string();
   let _=tokio::time::timeout(Duration::from_millis(180),redis::cmd("SET").arg(&key).arg(payload).arg("EX").arg(id.ttl).query_async::<()>(c)).await;
  }
 }
 response(raw,headers,"miss")
}
#[cfg(test)]mod tests{
 use super::*;
 fn request(path:&str)->Request{Request::builder().uri(path).body(Body::empty()).unwrap()}
 #[test]fn payload_echo_case_facets_and_duplicate_resolution_are_isolated(){
  let a=identity(&request("/api/marketplace-search-page?query=Charizard&limit=24")).unwrap();
  let b=identity(&request("/api/marketplace-search-page?query=charizard&limit=24")).unwrap();
  assert_ne!(a.key,b.key);
  assert_ne!(a.key,identity(&request("/api/marketplace-search-page?query=Charizard&limit=24&includeFacets=0")).unwrap().key);
  assert_eq!(a.key,identity(&request("/api/marketplace-search-page?query=Charizard&query=wrong&limit=24")).unwrap().key);
  let c=identity(&request("/api/marketplace-card-page?cardId=12&cardId=693360")).unwrap();
  assert_eq!(c.key,identity(&request("/api/marketplace-card-page?cardId=693360")).unwrap().key);
  assert!(identity(&request("/api/marketplace-card-page?cardId=693360&liveOffers=YES")).is_none());
  assert!(identity(&request("/api/marketplace-search-page?query=Charizard&limit=24&offset=24")).is_none());
 }
}
