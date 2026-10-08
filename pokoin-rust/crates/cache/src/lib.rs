use sha2::{Digest,Sha256};
fn hash(value:&str)->String{hex::encode(&Sha256::digest(value.as_bytes())[..8])}
fn game(value:&str)->&str{if value.trim().is_empty(){"pokemon"}else{value.trim()}}
/// Matches the corrected reference cache; optional sections/limits/lookup are isolated.
#[allow(clippy::too_many_arguments)]
pub fn card_page_key(game_id:&str,card_id:&str,lang:&str,offers:bool,sales:bool,same:bool,live:bool,offer_limit:i64,sales_limit:i64,slug:&str)->String{
 if live || card_id.trim().is_empty(){return String::new()}
 format!("pokoin:marketplace:v1:card-v2:{}:{}:{}:{}:{}:{}:{}:{}:{}",
 game(game_id),card_id.trim(),if lang.is_empty(){"en".into()}else{lang.to_lowercase()},
 if offers{"offers"}else{"nooffers"},if sales{"sales"}else{"nosales"},if same{"same"}else{"nosame"},
 if offers{offer_limit.clamp(1,80)}else{0},if sales{sales_limit.clamp(1,120)}else{0},hash(slug))
}
pub fn card_generation_key(game_id:&str,card_id:&str)->String{
 format!("pokoin:marketplace:v1:gen:card:{}:{card_id}",game(game_id))
}
#[allow(clippy::too_many_arguments)]
pub fn search_page_key(game_id:&str,query:&str,lang:&str,limit:i64,offset:i64,product_type:&str,print_language:&str,products:bool,facets:bool)->String{
 let text=query.trim().to_lowercase();let len=text.encode_utf16().count();
 if !(2..=48).contains(&len)||offset!=0||!(1..=48).contains(&limit){return String::new()}
 format!("pokoin:marketplace:v1:search-v2:{}:{}:{}:{}:{}:{}:{}:{}",game(game_id),
 if lang.is_empty(){"en".into()}else{lang.to_lowercase()},if product_type.is_empty(){"any"}else{product_type},
 if print_language.is_empty(){"all"}else{print_language},if products{"products"}else{"mixed"},if facets{"facets"}else{"nofacets"},limit,hash(&text))
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn card_cache_tracks_every_response_variant(){
  let base=card_page_key("pokemon","693360","en",true,true,false,false,40,40,"");
  assert_eq!(base,"pokoin:marketplace:v1:card-v2:pokemon:693360:en:offers:sales:nosame:40:40:e3b0c44298fc1c14");
  assert_ne!(base,card_page_key("pokemon","693360","en",true,true,false,false,20,40,""));
  assert_ne!(base,card_page_key("pokemon","693360","en",true,true,false,false,40,30,""));
  assert_ne!(base,card_page_key("pokemon","693360","en",true,true,false,false,40,40,"typed-slug"));
  assert_eq!(card_page_key("pokemon","693360","en",false,false,false,true,40,40,""),"");
  assert_eq!(card_generation_key("pokemon","693360"),"pokoin:marketplace:v1:gen:card:pokemon:693360");
 }
 #[test]fn facets_are_not_shared_and_uncached_pages_are_not_coalesced(){
  let key=search_page_key("pokemon","Charizard","en",24,0,"","all",false,true);
  assert_eq!(key,"pokoin:marketplace:v1:search-v2:pokemon:en:any:all:mixed:facets:24:73e512eccd9639bf");
  assert_ne!(key,search_page_key("pokemon","Charizard","en",24,0,"","all",false,false));
  assert_eq!(search_page_key("pokemon","Charizard","en",24,24,"","all",false,true),"");
 }
}
