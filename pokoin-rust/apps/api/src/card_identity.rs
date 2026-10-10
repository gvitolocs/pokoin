//! Catalog identity is a public Pokoin id, never a provider blueprint id.
use axum::{body::{Body,to_bytes},extract::Request,http::StatusCode,middleware::Next,response::Response};
use serde_json::{json,Value};
use crate::catalog_api;

pub fn matches(raw:&[u8],expected:&str,game:&str)->bool {
 let Ok(value)=serde_json::from_slice::<Value>(raw) else{return false};
 if value.get("game").and_then(Value::as_str).is_some_and(|s|s!=game){return false}
 let Some(card)=value.get("card") else{return false};
 let actual=pokoin_catalog::card::text(card,&["id","card_id"]);
 if catalog_api::positive_id(&actual)!=catalog_api::positive_id(expected){return false}
 for path in [value.get("canonicalPath"),card.get("canonicalPath"),card.get("canonical_path")].into_iter().flatten().filter_map(Value::as_str).filter(|s|!s.is_empty()) {
  let Some(id)=path.split("/cards/").nth(1).and_then(|s|s.split('/').next()) else{return false};
  if catalog_api::positive_id(id)!=catalog_api::positive_id(expected){return false}
  let prefix=path.split("/marketplace/").next().unwrap_or("");
  // The API emits game-less paths (the SPA adds the game slug with
  // publicGamePath), so a satellite card may carry either form; another
  // game's prefix is still rejected.
  let wanted=if game=="pokemon"{String::new()}else{format!("/{}",game.replace('_',"-"))};
  if !prefix.is_empty() && prefix!=wanted{return false}
 }
 true
}
pub fn expected(req:&Request)->Option<(String,String)>{
 if req.uri().path()!="/api/marketplace-card-page"{return None}
 let p=catalog_api::params(req.uri());
 let id=p.get("cardId").or_else(||p.get("id")).and_then(|s|catalog_api::positive_id(s))?;
 let game=crate::suggest::game_from(req.headers(),p.get("game").map(String::as_str));
 Some((id.to_string(),game))
}
pub async fn guard(req:Request,next:Next)->Response {
 let expected=expected(&req);
 let response=next.run(req).await;
 let Some((expected,game))=expected else{return response};
 if response.status()!=StatusCode::OK{return response}
 let (parts,body)=response.into_parts();
 match to_bytes(body,5*1024*1024).await {
  Ok(raw) if matches(&raw,&expected,&game)=>Response::from_parts(parts,Body::from(raw)),
  _=>{
   tracing::error!(card_id=%expected,%game,code="card_identity_mismatch","catalog response rejected");
   catalog_api::response(StatusCode::BAD_GATEWAY,json!({"error":"Card response identity did not match the requested card.","code":"card_identity_mismatch"}),"no-store")
  }
 }
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn another_card_or_provider_id_cannot_be_accepted(){
  assert!(matches(br#"{"card":{"id":"806342"},"canonicalPath":"/marketplace/en/cards/806342/kecleon"}"#,"806342","pokemon"));
  assert!(!matches(br#"{"card":{"id":"511164"},"canonicalPath":"/marketplace/en/cards/511164/toedscruel"}"#,"806342","pokemon"));
  assert!(!matches(br#"{"card":{"id":"403171"}}"#,"806342","pokemon"));
  assert!(!matches(br#"{"card":{"id":"806342","canonicalPath":"/marketplace/en/cards/511164/other"}}"#,"806342","pokemon"));
 }
 #[test]fn satellite_cards_accept_game_less_or_own_game_paths(){
  assert!(matches(br#"{"game":"yugioh","card":{"id":"831228","canonicalPath":"/marketplace/en/cards/831228/dark-magician"}}"#,"831228","yugioh"));
  assert!(matches(br#"{"card":{"id":"200074182","canonicalPath":"/weiss-schwarz/marketplace/en/cards/200074182/x"}}"#,"200074182","weiss_schwarz"));
  assert!(!matches(br#"{"card":{"id":"831228","canonicalPath":"/one-piece/marketplace/en/cards/831228/x"}}"#,"831228","yugioh"));
  assert!(!matches(br#"{"game":"one_piece","card":{"id":"831228"}}"#,"831228","yugioh"));
  assert!(!matches(br#"{"card":{"id":"806342","canonicalPath":"/yugioh/marketplace/en/cards/806342/x"}}"#,"806342","pokemon"));
 }
}
