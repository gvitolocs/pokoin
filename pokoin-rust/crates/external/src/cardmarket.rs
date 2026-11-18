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
/// Games whose Cardmarket product names have no collector number.
const NAME_ONLY_SEARCH_GAMES:[&str;2]=["battle_spirits_saga","weiss_schwarz"];
pub fn search_fallback(row:&Value,locale:&str,game:&str)->String{
 let locale=if rx(r"^[a-z]{2}$").is_match(locale){locale}else{"en"};let path=table()["games"][game].as_str().unwrap_or("Pokemon");
 let name=text(row,"name");let name=if game=="pokemon" {let n=rx(r"(?i)\b(mega|ex|gx|vmax|vstar|lv\.?\s*x|break|prime)\b").replace_all(&ascii_marks(&name)," ").into_owned();rx(r"[^\p{L}\p{N}]+").replace_all(&n," ").split_whitespace().find(|s|s.len()>1).unwrap_or("").to_lowercase()} else {name.trim().to_owned()};
 let number=["expansion_number","card_number","number"].iter().map(|k|text(row,k)).find(|s|!s.is_empty()).unwrap_or_default();let number=number.trim();let number=if game!="pokemon"&&!number.contains('|')&&!rx(r"^\d+[A-Za-z]?\s*/\s*\d+").is_match(number){number.to_owned()}else{let right=number.split_once('|').filter(|(left,right)|!left.is_empty()&&!right.trim().is_empty()).map(|(_,r)|r.trim()).unwrap_or(number);right.split('/').next().unwrap_or("").trim().to_owned()};
 // Battle Spirits Saga and Weiss Schwarz product names on Cardmarket never carry the card number,
 // so a name + number search finds nothing; search the name alone.
 let number=if NAME_ONLY_SEARCH_GAMES.contains(&game){String::new()}else{number};
 let search=[name,number].into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" ");
 let base=if game=="pokemon"{format!("https://www.cardmarket.com/{locale}/Pokemon/Products/Singles")}else{format!("https://www.cardmarket.com/{locale}/{path}/Products/Search")};
 let mut serializer=url::form_urlencoded::Serializer::new(String::new());if game=="pokemon"{serializer.append_pair("searchMode","v2").append_pair("idCategory","51").append_pair("idExpansion","0");}serializer.append_pair("searchString",&search);if game=="pokemon"{serializer.append_pair("idRarity","0").append_pair("perSite","30");}format!("{base}?{}",serializer.finish())
}
async fn row_for(db:&DbPools,game:&str,id:&str)->ApiResult<Option<Value>> {
 let rows=match db.query(game,include_str!("fixtures/cardmarket/baseQuery.sql"),&[json!(id.parse::<i64>().unwrap_or(0))]).await {
  Err(e) if e.is_table_missing()=>db.query(game,include_str!("fixtures/cardmarket/fallbackQuery.sql"),&[json!(id.parse::<i64>().unwrap_or(0))]).await?,r=>r?};Ok(rows.into_iter().next())
}
/// One verified Cardmarket product for a card, and which stored source supplied it.
#[derive(Debug,Clone,PartialEq,Eq,serde::Serialize)]
pub struct Match{pub url:String,pub source:&'static str,pub label:String}
/// `{Expansion} · {Product}` from the URL tail: `.../Singles/Play-Pokemon-Prize-Pack-Series-Two/Cherens-Care-V1-PPS2BRS-134`
/// → `Play Pokemon Prize Pack Series Two · Cherens Care V1 PPS2BRS 134`.
pub fn match_label(url:&str)->String{
 let path=url.split(['?','#']).next().unwrap_or("");let path=path.split_once("://").map(|(_,rest)|rest.split_once('/').map(|(_,p)|p).unwrap_or("")).unwrap_or(path);
 let parts:Vec<&str>=path.split('/').filter(|s|!s.is_empty()).collect();
 let words=|s:&str|percent_encoding::percent_decode_str(s).decode_utf8_lossy().replace('-'," ").split_whitespace().collect::<Vec<_>>().join(" ");
 let tail:Vec<String>=match parts.as_slice(){[_,..,a,b] if !["Singles","Products","Search"].contains(a)=>vec![words(a),words(b)],[..,b]=>vec![words(b)],_=>vec![]};
 let label=tail.into_iter().filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" · ");if label.is_empty(){"Cardmarket".into()}else{label}
}
/// Every stored URL in source order: printing links, then verified links, then parsing rows. `rows` are the
/// tier 2/3 rows in SQL order (`priority` 0 verified link, 1 parsing; newest first); within that the requested
/// locale beats the `en` fallback. Duplicate URLs keep their first, highest-priority source.
pub fn merge_matches(printing:&[String],rows:&[Value],locale:&str)->Vec<Match>{
 let mut ranked:Vec<&Value>=rows.iter().collect();ranked.sort_by_key(|r|(text(r,"cardmarket_locale")!=locale,text(r,"priority")!="0"));
 let mut out:Vec<Match>=vec![];
 let all=printing.iter().map(|u|(u.clone(),"printing_link")).chain(ranked.into_iter().map(|r|(text(r,"cardmarket_url"),if text(r,"priority")=="0"{"verified_link"}else{"parsing"})));
 for (url,source) in all {let url=url.trim().to_owned();if !url.is_empty()&&!out.iter().any(|m|m.url==url){out.push(Match{label:match_label(&url),url,source})}}out
}
async fn stored_urls(db:&DbPools,game:&str,public_id:&str,leftover:&str,locale:&str)->ApiResult<Vec<Match>>{
 let printing=db.query(game,"select cm_url from public.pokoin_printing_cm_links where public_id = $1 and cm_url <> '' limit 1",&[json!(public_id.parse::<i64>().unwrap_or(0))]).await;
 let printing:Vec<String>=printing.map(|rows|rows.iter().map(|r|text(r,"cm_url")).collect()).unwrap_or_default();
 let sql="select cardmarket_url, cardmarket_locale, 0 as priority, verified_at, updated_at from public.marketplace_cm_verified_links where blueprint_id = $1 and cardmarket_locale in ($2, 'en') and confidence in ('verified', 'manual') union all select cardmarket_url, cardmarket_locale, 1 as priority, verified_at, updated_at from public.marketplace_cm_product_parsing where blueprint_id = $1 and cardmarket_locale in ($2, 'en') and match_status in ('verified', 'manual') order by priority, verified_at desc nulls last, updated_at desc";
 let params=[json!(leftover.parse::<i64>().unwrap_or(0)),json!(locale)];
 let rows=match db.query(game,sql,&params).await {Err(e) if e.is_table_missing()=>match db.query(game,"select cardmarket_url, cardmarket_locale, 1 as priority from public.marketplace_cm_product_parsing where blueprint_id = $1 and cardmarket_locale in ($2, 'en') and match_status in ('verified', 'manual') order by verified_at desc nulls last, updated_at desc",&params).await{Err(e) if e.is_table_missing()=>vec![],r=>r?},r=>r?};
 Ok(merge_matches(&printing,&rows,locale))
}
async fn stored_url(db:&DbPools,game:&str,public_id:&str,leftover:&str,locale:&str)->ApiResult<String>{Ok(stored_urls(db,game,public_id,leftover,locale).await?.into_iter().next().map(|m|m.url).unwrap_or_default())}
/// The card row and the keys its stored links hang off (`active` game, public id, stored-link key).
async fn lookup(db:&DbPools,game:&str,id:&str,hint:&str)->ApiResult<(Value,String,String,String)>{
 let key=if id.is_empty(){hint}else{id};let hit=crate::redirects::catalog_ids_for_any_game(db,game,key).await?;let active=hit.as_ref().map(|(g,_)|g.as_str()).unwrap_or(game).to_owned();
 let leftover=if !hint.is_empty()&&hint!=id{hint.to_owned()}else{hit.as_ref().map(|(_,h)|h.ct_id.clone()).unwrap_or_default()};let public=hit.as_ref().map(|(_,h)|h.card_id.clone()).filter(|s|!s.is_empty()).unwrap_or_else(||id.to_owned());
 let mut row=if !public.is_empty(){match row_for(db,&active,&public).await{Err(e) if e.is_table_missing()=>None,r=>r?}}else{None};
 if row.is_none()&&!leftover.is_empty()&&leftover!=public{row=match row_for(db,&active,&leftover).await{Err(e) if e.is_table_missing()=>None,r=>r?}}
 if let Some((_,hit))=&hit {if row.is_none()&&!hit.name.is_empty(){row=Some(json!({"card_id":if leftover.is_empty(){&public}else{&leftover},"name":hit.name,"expansion_name":hit.set_name,"expansion_number":hit.card_number}))}else if let Some(row)=row.as_mut(){if text(row,"expansion_number").is_empty()&&!hit.card_number.is_empty(){row["expansion_number"]=json!(hit.card_number)}}}
 let row=row.ok_or_else(||ApiError::not_found("Blueprint not found."))?;
 if is_misprint(&row){return Err(ApiError::new(409,"Cardmarket does not have a dedicated Pokémon Misprints singles section. Please search Cardmarket manually or list the misprint directly on Pokoin.").with_code("CARDMARKET_MISPRINT_UNSUPPORTED"))}
 let stored_key=if leftover.is_empty(){id.to_owned()}else{leftover};Ok((row,active,public,stored_key))
}
fn generated(row:&Value,active:&str,locale:&str)->ApiResult<String>{
 let target=if active=="pokemon"&&can_generate_direct(row){candidate_urls(row,locale).into_iter().next().unwrap_or_default()}else{search_fallback(row,locale,active)};
 if target.is_empty(){return Err(ApiError::not_found("No Cardmarket URL candidate found."))}Ok(target)
}
pub async fn resolve(db:&DbPools,game:&str,id:&str,hint:&str,locale:&str)->ApiResult<String>{
 let (row,active,public,stored_key)=lookup(db,game,id,hint).await?;
 let stored=stored_url(db,&active,&public,&stored_key,locale).await?;if !stored.is_empty(){return Ok(stored)}generated(&row,&active,locale)
}
/// What `resolve` opens (`primary`) plus every stored verified match behind it; `matches` is empty when the
/// button falls back to a generated product or search URL.
pub async fn matches(db:&DbPools,game:&str,id:&str,hint:&str,locale:&str)->ApiResult<(String,Vec<Match>)>{
 let (row,active,public,stored_key)=lookup(db,game,id,hint).await?;
 let all=stored_urls(db,&active,&public,&stored_key,locale).await?;
 let primary=match all.first(){Some(m)=>m.url.clone(),None=>generated(&row,&active,locale)?};Ok((primary,all))
}
#[cfg(test)]mod tests{use super::*;
 #[test]fn weiss_schwarz_searches_the_name_only(){let row=json!({"name":"Bullied Kid, Haruyuki","expansion_number":"AW/S18-E020"});assert_eq!(search_fallback(&row,"en","weiss_schwarz"),"https://www.cardmarket.com/en/WeissSchwarz/Products/Search?searchString=Bullied+Kid%2C+Haruyuki");}
 #[test]fn battle_spirits_saga_searches_the_name_only(){let row=json!({"name":"Air Sniper Breeze","expansion_number":"BSS02-070"});assert_eq!(search_fallback(&row,"en","battle_spirits_saga"),"https://www.cardmarket.com/en/BattleSpiritsSaga/Products/Search?searchString=Air+Sniper+Breeze");}
 #[test]fn golden_contracts_from_live_node(){let cases:Vec<Value>=serde_json::from_str(include_str!("fixtures/cardmarket/contracts.json")).unwrap();for c in cases{let r=&c["row"];let game=c["game"].as_str().unwrap();assert_eq!(card_name_slug(&text(r,"name")),c["slug"]);assert_eq!(normalized_collector_number(&text(r,"expansion_number")),c["collector"]);assert_eq!(json!(candidate_urls(r,"it")),c["candidates"]);assert_eq!(search_fallback(r,"it",game),c["search"]);assert_eq!(can_generate_direct(r),c["direct"]);assert_eq!(is_misprint(r),c["misprint"]);}}
 fn row(url:&str,priority:u8,locale:&str)->Value{json!({"cardmarket_url":url,"priority":priority,"cardmarket_locale":locale})}
 const SHARPEDO_V1:&str="https://www.cardmarket.com/en/Pokemon/Products/Singles/XY-Black-Star-Promos/M-Sharpedo-EX-V1-XYPRXY200";
 const SHARPEDO_V2:&str="https://www.cardmarket.com/en/Pokemon/Products/Singles/XY-Black-Star-Promos/M-Sharpedo-EX-V2-XYPRXY200a";
 #[test]fn matches_keep_source_order_and_drop_duplicate_urls(){
  let out=merge_matches(&[SHARPEDO_V1.into()],&[row(SHARPEDO_V1,0,"en"),row(SHARPEDO_V2,1,"en"),row(SHARPEDO_V2,1,"en"),row("",1,"en")],"en");
  assert_eq!(out.iter().map(|m|(m.url.as_str(),m.source)).collect::<Vec<_>>(),vec![(SHARPEDO_V1,"printing_link"),(SHARPEDO_V2,"parsing")]);
 }
 #[test]fn verified_links_beat_parsing_rows_even_when_sql_order_is_newer(){
  let out=merge_matches(&[],&[row("https://x/a",1,"en"),row("https://x/b",0,"en")],"en");
  assert_eq!(out.iter().map(|m|m.source).collect::<Vec<_>>(),vec!["verified_link","parsing"]);
 }
 #[test]fn requested_locale_comes_before_the_english_fallback(){
  let out=merge_matches(&[],&[row("https://x/en-verified",0,"en"),row("https://x/it-parsing",1,"it"),row("https://x/it-verified",0,"it"),row("https://x/en-parsing",1,"en")],"it");
  assert_eq!(out.iter().map(|m|m.url.as_str()).collect::<Vec<_>>(),vec!["https://x/it-verified","https://x/it-parsing","https://x/en-verified","https://x/en-parsing"]);
 }
 #[test]fn english_locale_keeps_sql_order(){
  let rows=[row("https://x/v-new",0,"en"),row("https://x/v-old",0,"en"),row("https://x/p-new",1,"en"),row("https://x/p-old",1,"en")];
  assert_eq!(merge_matches(&[],&rows,"en").iter().map(|m|m.url.as_str()).collect::<Vec<_>>(),vec!["https://x/v-new","https://x/v-old","https://x/p-new","https://x/p-old"]);
 }
 #[test]fn labels_name_the_expansion_and_product(){
  assert_eq!(match_label("https://www.cardmarket.com/en/Pokemon/Products/Singles/Play-Pokemon-Prize-Pack-Series-Two/Cherens-Care-V1-PPS2BRS-134"),"Play Pokemon Prize Pack Series Two · Cherens Care V1 PPS2BRS 134");
  assert_eq!(match_label(&format!("{SHARPEDO_V2}?language=1")),"XY Black Star Promos · M Sharpedo EX V2 XYPRXY200a");
  assert_eq!(match_label("https://www.cardmarket.com/en/Pokemon/Products/Singles/Lotad"),"Lotad");
  assert_eq!(match_label("https://www.cardmarket.com/"),"Cardmarket");
 }
}
