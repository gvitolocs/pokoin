//! Native Cardmarket redirect resolution. SQL and golden cases are from live Node.
use serde_json::{json,Value};
use regex::Regex;
use unicode_normalization::UnicodeNormalization;
use std::sync::OnceLock;
use crate::{db::DbPools,error::{ApiError,ApiResult}};
fn table()-> &'static Value { static T:OnceLock<Value>=OnceLock::new(); T.get_or_init(||serde_json::from_str(include_str!("fixtures/cardmarket/tables.json")).unwrap_or_default()) }
fn text(row:&Value,key:&str)->String { match row.get(key) {Some(Value::String(s))=>s.clone(),Some(Value::Number(n))=>n.to_string(),_=>String::new()} }
fn rx(s:&str)->Regex {Regex::new(s).expect("static Cardmarket regex")}
fn ascii_marks(s:&str)->String {s.nfkd().filter(|c|!('\u{0300}'..='\u{036f}').contains(c)).collect()}
pub fn slug_part(s:&str)->String {rx("[^a-zA-Z0-9]+").replace_all(&ascii_marks(s).replace('&'," ").replace(['\'','’','`'],""),"-").trim_matches('-').to_owned()}
pub fn card_name_slug(s:&str)->String {slug_part(&rx(r"(?i)\b(?:Shiny Rare|Rare Holo|Holo)\b").replace_all(s,""))}
pub fn normalized_collector_number(s:&str)->String {
 let s=s.replace("||","|");let s=s.trim();
 for pattern in [r"(?i)([A-Z]*\d+[A-Z]?\s*/\s*\d+)",r"(?i)\b([A-Z]{1,4}\s*\d+)\b",r"(?i)\bStamp Number\s+(\d+)\b",r"(?i)\b(?:No\.)?0*(\d{1,4})\b"] {
  if let Some(c)=rx(pattern).captures(s){return rx(r"\s+").replace_all(c.get(1).map(|m|m.as_str()).unwrap_or(""),"").into_owned()}
 }s.to_owned()
}
fn unique(rows:Vec<String>)->Vec<String>{let mut v=Vec::new();for r in rows {if !r.is_empty()&&!v.contains(&r){v.push(r)}}v}
fn set_code(row:&Value)->String{
 let code=text(row,"cardmarket_set_code");if !code.is_empty(){return code.trim().into()}
 let name=text(row,"expansion_name");let known=table()["sets"][name.trim()].as_str().unwrap_or("");
 if !known.is_empty(){known.into()}else{rx("[^a-zA-Z0-9]").replace_all(&text(row,"expansion_code"),"").to_uppercase()}
}
fn expansion_slug(row:&Value)->String {let explicit=text(row,"cardmarket_expansion_slug");if !explicit.is_empty(){return explicit.trim().into()}let name=text(row,"expansion_name");table()["expansions"][name.trim()].as_str().map(str::to_owned).unwrap_or_else(||slug_part(&name))}
pub fn collector_candidates(s:&str,set:&str)->Vec<String>{
 let raw=normalized_collector_number(s);if raw.is_empty()||set.is_empty(){return vec![]}
 let clean=raw.split('/').next().unwrap_or("").split_whitespace().collect::<String>().to_uppercase();if !clean.chars().any(|c|c.is_ascii_digit()){return vec![]}
 if let Some(c)=rx(r"^([A-Z]+)(\d+)$").captures(&clean){
  let prefix=c.get(1).map(|m|m.as_str()).unwrap_or("");let n=c.get(2).map(|m|m.as_str()).unwrap_or("");let value=n.parse::<u64>().unwrap_or(0);
  return unique(vec![format!("{prefix}{n}"),format!("{prefix}{clean}"),format!("{set}{n}"),format!("{set}{prefix}{value:02}"),format!("{set}{prefix}{n}"),format!("{set}{prefix}{value:03}")])
 }
 if let Some(c)=rx(r"^0*(\d+)[A-Z]?$").captures(&clean){let value=c.get(1).and_then(|m|m.as_str().parse::<u64>().ok()).unwrap_or(0);let suffix=clean.trim_start_matches(|c:char|c.is_ascii_digit());let plain=format!("{set}{value}{suffix}");let p3=format!("{set}{value:03}{suffix}");let p2=format!("{set}{value:02}{suffix}");return unique(if clean.starts_with('0'){vec![p3,plain,p2]}else{vec![plain,p3,p2]})}
 vec![format!("{set}{clean}")]
}
pub fn is_misprint(row:&Value)->bool {ascii_marks(&text(row,"expansion_name")).trim().eq_ignore_ascii_case("pokemon misprints")}
fn verified(row:&Value)->String {table()["verified"][text(row,"card_id")].as_str().unwrap_or("").into()}
pub fn can_generate_direct(row:&Value)->bool {if is_misprint(row){return false}if !verified(row).is_empty(){return true}let name=text(row,"expansion_name");if text(row,"cardmarket_expansion_slug").is_empty()&&table()["expansions"].get(name.trim()).is_none(){return false}let known=table()["sets"][name.trim()].as_str().unwrap_or("");let explicit=text(row,"cardmarket_set_code");let code=if explicit.is_empty(){known}else{&explicit};!code.is_empty()&&!collector_candidates(&text(row,"expansion_number"),code).is_empty()}
pub fn candidate_urls(row:&Value,locale:&str)->Vec<String>{
 if is_misprint(row){return vec![]}let verified=verified(row);if !verified.is_empty(){return vec![verified]}
 let expansion=expansion_slug(row);let name=card_name_slug(&text(row,"name"));let name_only=format!("https://www.cardmarket.com/{locale}/Pokemon/Products/Singles/{expansion}/{name}");let mut urls=vec![];
 let kind=text(row,"card_type").to_lowercase();if ["Night Unison","Rising Fist"].contains(&text(row,"expansion_name").trim())&&rx(r"\b(trainer|supporter|item|stadium|tool|special energy|energy)\b").is_match(&kind){urls.push(name_only.clone())}
 let mut markers=vec![];for k in ["product_variant","inferred_product_variant"] {let v=text(row,k);if rx(r"(?i)^v\d+$").is_match(v.trim()){markers.push(v.trim().to_uppercase())}}markers.push(String::new());let markers=unique_keep_empty(markers);
 for code in collector_candidates(&text(row,"expansion_number"),&set_code(row)){for marker in &markers{let parts=vec![name.clone(),marker.clone(),code.clone()].into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join("-");urls.push(format!("https://www.cardmarket.com/{locale}/Pokemon/Products/Singles/{expansion}/{parts}"))}}
 urls.push(name_only);unique(urls)
}
fn unique_keep_empty(rows:Vec<String>)->Vec<String>{let mut v=vec![];for r in rows {if !v.contains(&r){v.push(r)}}v}
pub fn search_fallback(row:&Value,locale:&str,game:&str)->String{
 let locale=if rx(r"^[a-z]{2}$").is_match(locale){locale}else{"en"};let path=table()["games"][game].as_str().unwrap_or("Pokemon");
 let name=text(row,"name");let name=if game=="pokemon" {let n=rx(r"(?i)\b(mega|ex|gx|vmax|vstar|lv\.?\s*x|break|prime)\b").replace_all(&ascii_marks(&name)," ").into_owned();rx(r"[^\p{L}\p{N}]+").replace_all(&n," ").split_whitespace().find(|s|s.len()>1).unwrap_or("").to_lowercase()} else {name.trim().to_owned()};
 let number=["expansion_number","card_number","number"].iter().map(|k|text(row,k)).find(|s|!s.is_empty()).unwrap_or_default();let number=number.trim();let number=if game!="pokemon"&&!number.contains('|')&&!rx(r"^\d+[A-Za-z]?\s*/\s*\d+").is_match(number){number.to_owned()}else{let right=number.split_once('|').filter(|(left,right)|!left.is_empty()&&!right.trim().is_empty()).map(|(_,r)|r.trim()).unwrap_or(number);right.split('/').next().unwrap_or("").trim().to_owned()};
 let search=[name,number].into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" ");
 let base=if game=="pokemon"{format!("https://www.cardmarket.com/{locale}/Pokemon/Products/Singles")}else{format!("https://www.cardmarket.com/{locale}/{path}/Products/Search")};
 let mut serializer=url::form_urlencoded::Serializer::new(String::new());if game=="pokemon"{serializer.append_pair("searchMode","v2").append_pair("idCategory","51").append_pair("idExpansion","0");}serializer.append_pair("searchString",&search);if game=="pokemon"{serializer.append_pair("idRarity","0").append_pair("perSite","30");}format!("{base}?{}",serializer.finish())
}
async fn row_for(db:&DbPools,game:&str,id:&str)->ApiResult<Option<Value>> {
 let rows=match db.query(game,include_str!("fixtures/cardmarket/baseQuery.sql"),&[json!(id.parse::<i64>().unwrap_or(0))]).await {
  Err(e) if e.is_table_missing()=>db.query(game,include_str!("fixtures/cardmarket/fallbackQuery.sql"),&[json!(id.parse::<i64>().unwrap_or(0))]).await?,r=>r?};Ok(rows.into_iter().next())
}
async fn stored_url(db:&DbPools,game:&str,public_id:&str,leftover:&str,locale:&str)->ApiResult<String>{
 let printing=db.query(game,"select cm_url from public.pokoin_printing_cm_links where public_id = $1 and cm_url <> '' limit 1",&[json!(public_id.parse::<i64>().unwrap_or(0))]).await;
 if let Ok(rows)=printing {if let Some(row)=rows.first(){let url=text(row,"cm_url");if !url.is_empty(){return Ok(url)}}}
 let sql="select cardmarket_url, 0 as priority, verified_at, updated_at from public.marketplace_cm_verified_links where blueprint_id = $1 and cardmarket_locale = $2 and confidence in ('verified', 'manual') union all select cardmarket_url, 1 as priority, verified_at, updated_at from public.marketplace_cm_product_parsing where blueprint_id = $1 and cardmarket_locale = $2 and match_status in ('verified', 'manual') order by priority, verified_at desc nulls last, updated_at desc limit 1";
 let rows=match db.query(game,sql,&[json!(leftover.parse::<i64>().unwrap_or(0)),json!(locale)]).await {Err(e) if e.is_table_missing()=>match db.query(game,"select cardmarket_url from public.marketplace_cm_product_parsing where blueprint_id = $1 and cardmarket_locale = $2 and match_status in ('verified', 'manual') order by verified_at desc nulls last, updated_at desc limit 1",&[json!(leftover.parse::<i64>().unwrap_or(0)),json!(locale)]).await{Err(e) if e.is_table_missing()=>vec![],r=>r?},r=>r?};Ok(rows.first().map(|r|text(r,"cardmarket_url")).unwrap_or_default())
}
pub async fn resolve(db:&DbPools,game:&str,id:&str,hint:&str,locale:&str)->ApiResult<String>{
 let key=if id.is_empty(){hint}else{id};let hit=crate::redirects::catalog_ids_for_any_game(db,game,key).await?;let active=hit.as_ref().map(|(g,_)|g.as_str()).unwrap_or(game);
 let leftover=if !hint.is_empty()&&hint!=id{hint.to_owned()}else{hit.as_ref().map(|(_,h)|h.ct_id.clone()).unwrap_or_default()};let public=hit.as_ref().map(|(_,h)|h.card_id.clone()).filter(|s|!s.is_empty()).unwrap_or_else(||id.to_owned());
 let mut row=if !public.is_empty(){match row_for(db,active,&public).await{Err(e) if e.is_table_missing()=>None,r=>r?}}else{None};
 if row.is_none()&&!leftover.is_empty()&&leftover!=public{row=match row_for(db,active,&leftover).await{Err(e) if e.is_table_missing()=>None,r=>r?}}
 if let Some((_,hit))=&hit {if row.is_none()&&!hit.name.is_empty(){row=Some(json!({"card_id":if leftover.is_empty(){&public}else{&leftover},"name":hit.name,"expansion_name":hit.set_name,"expansion_number":hit.card_number}))}else if let Some(row)=row.as_mut(){if text(row,"expansion_number").is_empty()&&!hit.card_number.is_empty(){row["expansion_number"]=json!(hit.card_number)}}}
 let row=row.ok_or_else(||ApiError::not_found("Blueprint not found."))?;
 if is_misprint(&row){return Err(ApiError::new(409,"Cardmarket does not have a dedicated Pokémon Misprints singles section. Please search Cardmarket manually or list the misprint directly on Pokoin.").with_code("CARDMARKET_MISPRINT_UNSUPPORTED"))}
 let stored_key=if leftover.is_empty(){id}else{&leftover};let stored=stored_url(db,active,&public,stored_key,locale).await?;
 let target=if !stored.is_empty(){stored}else if active=="pokemon"&&can_generate_direct(&row){candidate_urls(&row,locale).into_iter().next().unwrap_or_default()}else{search_fallback(&row,locale,active)};
 if target.is_empty(){return Err(ApiError::not_found("No Cardmarket URL candidate found."))}Ok(target)
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn golden_contracts_from_live_node(){let cases:Vec<Value>=serde_json::from_str(include_str!("fixtures/cardmarket/contracts.json")).unwrap();for c in cases{let r=&c["row"];let game=c["game"].as_str().unwrap();assert_eq!(card_name_slug(&text(r,"name")),c["slug"]);assert_eq!(normalized_collector_number(&text(r,"expansion_number")),c["collector"]);assert_eq!(json!(candidate_urls(r,"it")),c["candidates"]);assert_eq!(search_fallback(r,"it",game),c["search"]);assert_eq!(can_generate_direct(r),c["direct"]);assert_eq!(is_misprint(r),c["misprint"]);}}
}
