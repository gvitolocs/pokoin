//! Public card serialization shared by every native catalog endpoint.
use serde_json::{json, Value};
use unicode_segmentation::UnicodeSegmentation;

pub fn text(row: &Value, keys: &[&str]) -> String {
    keys.iter().find_map(|k| row.get(k).and_then(|v| match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })).unwrap_or_default()
}
pub fn number(row: &Value, keys: &[&str]) -> f64 {
    keys.iter().find_map(|k| row.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok())).filter(|n| n.is_finite() && *n != 0.0)).unwrap_or(0.0)
}
fn flag(row: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|k| row.get(k).and_then(Value::as_bool) == Some(true))
}
fn image(raw: &str, id: &str, ct: &str) -> String {
    let mut result=raw.trim().to_owned();
    let multigame=["one-piece","riftbound","magic","yugioh","lorcana","flesh-and-blood","digimon","dragon-ball-super","vanguard","star-wars","union-arena","gundam","sorcery","palworld","cyberpunk","weiss-schwarz","final-fantasy","force-of-will","world-of-warcraft","battle-spirits-saga","star-wars-destiny","dragon-born","my-little-pony","the-spoils"].iter().any(|g| result.contains(&format!("/{g}/")) || result.starts_with(&format!("{g}/")));
    if !multigame && !ct.is_empty() && ct!=id {
        let parts=result.split('/').map(|p| p.strip_prefix(&format!("{ct}_")).map(|tail| format!("{id}_{tail}")).unwrap_or_else(||p.to_owned())).collect::<Vec<_>>();
        result=parts.join("/");
    }
    if !multigame {
        let filename=result.split(['?','#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
        if let Some((prefix,_))=filename.split_once('_') {
            if prefix.chars().all(|c|c.is_ascii_digit()) && !id.is_empty() && prefix!=id && prefix!=ct {return String::new()}
        }
    }
    if let Some(path)=result.strip_prefix("https://cdn.pokoin.com").or_else(||result.strip_prefix("http://cdn.pokoin.com")) {
        return format!("/card-images{path}")
    }
    result
}
fn slug_image(value: &str)->String {
    let file=value.split(['?','#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
    let file=file.rsplit_once('.').map(|(s,_)|s).unwrap_or(file).trim_end_matches("_homepage");
    file.split_once('_').filter(|(id,_)|id.chars().all(|c|c.is_ascii_digit())).map(|(_,s)|s).unwrap_or(file).to_lowercase()
}
fn emojis(value:&str)->Vec<String> {
    value.graphemes(true).map(str::trim).filter(|s|!s.is_empty()).map(str::to_owned).collect()
}
pub fn react_record(row: &Value) -> Value {
    let id=text(row,&["card_id","id"]);
    let ct=text(row,&["ct_id","ctId"]);
    let ct=if ct.is_empty(){id.parse::<i64>().ok().filter(|i|i%2==0 && *i>0).map(|i|(i/2).to_string()).unwrap_or_default()}else{ct};
    let raw=image(&text(row,&["cdn_image_url","cdnImageUrl","image_url","imageUrl"]),&id,&ct);
    let preview=image(&text(row,&["preview_image_url","previewImageUrl"]),&id,&ct);
    let home=image(&text(row,&["homepage_image_url","homepageImageUrl"]),&id,&ct);
    let foreign_full=raw.is_empty() && !text(row,&["cdn_image_url","image_url"]).is_empty();
    let full=if raw.is_empty(){if preview.is_empty(){home.clone()}else{preview.clone()}}else{raw};
    let preview=if preview.is_empty() || (preview.contains("/previews/") && preview.split('?').next().unwrap_or("").ends_with(".webp") && [".jpg",".jpeg",".png"].iter().any(|e|full.split('?').next().unwrap_or("").ends_with(e))){full.clone()}else{preview};
    let same_revision=home.split_once('?').map(|(_,q)|q)==full.split_once('?').map(|(_,q)|q);
    let use_home=same_revision && home.split('?').next().unwrap_or("").ends_with("_homepage.webp") && (foreign_full || (!slug_image(&home).is_empty() && slug_image(&home)==slug_image(&full)));
    let name=text(row,&["name"]);
    let set=text(row,&["set","set_name","expansion_name"]);
    let collector=text(row,&["number","card_number","expansion_number"]);
    let rarity=text(row,&["rarity"]);
    let rarity=if rarity.is_empty(){"Card".into()}else{rarity};
    let kind=text(row,&["item_kind","itemKind"]);
    let product=text(row,&["product_type","productType"]);
    let numbered=pokoin_search::has_collector(&text(row,&["card_number","expansion_number","version"]));
    let artist=text(row,&["artist","illustrator"]);
    let illustrator=text(row,&["illustrator","artist"]);
    let identity=if let Some(a)=row.get("cardIdentityEmojis").or_else(||row.get("card_identity_emojis")).and_then(Value::as_array){a.iter().flat_map(|v|emojis(v.as_str().unwrap_or(""))).collect()}else{emojis(&text(row,&["cardIdentityEmoji","card_identity_emoji"]))};
    let variant=emojis(&text(row,&["rarityVariantEmoji","rarity_variant_emoji","variantEmoji","variant_emoji"])).into_iter().next().unwrap_or_default();
    let price=number(row,&["price","lowest_price_pkn"]);
    let stock=number(row,&["stock","listed_quantity"]);
    let has_ct=flag(row,&["hasCardTraderListing","has_cardtrader_listing"]);
    let count=number(row,&["cardtraderEligibleListingCount","cardtrader_eligible_listing_count"]);
    let available=number(row,&["stock","listed_quantity","cardtraderListedQuantity","cardtrader_listed_quantity"])>0.0 || has_ct || flag(row,&["cardtrader_available"]) || count>0.0;
    let known=has_ct || ["hasCardTraderListing","has_cardtrader_listing"].iter().any(|k|row.get(k).and_then(Value::as_bool)==Some(false)) || stock>0.0 || price>0.0;
    let path=text(row,&["canonicalPath","canonical_path"]);
    let layout=text(row,&["artLayout","art_layout"]);
    let rarity_kind=text(row,&["rarity_kind","rarityKind"]).to_lowercase();
    let version_count=number(row,&["versionCount","version_count","member_count"]);
    let mut card=json!({
      "id":id,"card_id":id,"name":name,"set":set,"set_name":set,"number":collector,"card_number":collector,"rarity":rarity,
      "rarityKind":if ["rainbow","gold","ghost"].contains(&rarity_kind.as_str()){rarity_kind}else{String::new()},
      "itemKind":if numbered{"single"}else if kind.is_empty(){"single"}else{&kind},
      "productType":if numbered{"card"}else if product.is_empty(){"card"}else{&product},
      "canonicalPath":path,"canonical_path":path,"artist":artist,"illustrator":illustrator,
      "cardIdentityEmoji":identity.join(" "),"card_identity_emoji":identity.join(" "),"cardIdentityEmojis":identity,"card_identity_emojis":identity,
      "rarityVariantEmoji":variant,"rarity_variant_emoji":variant,"emoji":text(row,&["emoji"]),
      "version":text(row,&["version"]),"artLayout":layout,"art_layout":layout,"artShade":text(row,&["artShade","art_shade"]),
      "nationality":text(row,&["nationality"]),"versionCount":if version_count!=0.0{json!(version_count)}else{Value::Null},
      "expansionSymbolUrl":text(row,&["expansion_symbol_url","expansionSymbolUrl"]),
      "imageUrl":full,"previewImageUrl":preview,"homepageImageUrl":if use_home{home.clone()}else{String::new()},
      "gridImageUrl":full,"heroImageUrl":full,"tileImageUrl":if use_home{home}else{full},
      "price":if price>0.0{json!(price)}else{Value::Null},"stock":stock,
      "hasCardTraderListing":has_ct,"cardtraderEligibleListingCount":count,
      "isMarketAvailable":available,"inStock":available,"availabilityKnown":known
    });
    for (target,keys) in [("localized_name",["localized_name","localizedName"]),("localized_set",["localized_set","localizedSet"]),("localized_rarity",["localized_rarity","localizedRarity"])] {
        let v=text(row,&keys);if !v.is_empty(){card[target]=json!(v);}
    }
    card
}
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn public_images_reject_foreign_and_prefer_full_raster() {
  let card=react_record(&json!({"card_id":20,"ct_id":10,"cdn_image_url":"https://cdn.pokoin.com/5_wrong.jpg","preview_image_url":"https://cdn.pokoin.com/previews/10_correct.jpg","homepage_image_url":"https://cdn.pokoin.com/10_correct_homepage.webp"}));
  assert_eq!(card["imageUrl"],"/card-images/previews/20_correct.jpg");
  assert_eq!(card["tileImageUrl"],"/card-images/20_correct_homepage.webp");
 }
 #[test] fn semantic_metadata_survives_and_printings_are_not_variants() {
  let card=react_record(&json!({"card_id":20,"version":"v123","product_variant":"foil","rarity_kind":"gold","art_layout":"bleed","emoji":"🔥  ","cardIdentityEmoji":"👨‍👩‍👧‍👦","has_cardtrader_listing":false,"lowest_price_pkn":24}));
  assert_eq!(card["version"],"v123");assert_eq!(card["rarityKind"],"gold");
  assert_eq!(card["cardIdentityEmojis"].as_array().unwrap().len(),1);
  assert_eq!(card["emoji"],"🔥");assert_eq!(card["availabilityKnown"],true);assert_eq!(card["inStock"],false);
 }
 #[test]fn updated_full_scan_does_not_reuse_an_old_homepage_thumbnail(){
  let card=react_record(&json!({"card_id":20,"ct_id":10,"cdn_image_url":"https://cdn.pokoin.com/10_correct.jpg?v=we1","homepage_image_url":"https://cdn.pokoin.com/10_correct_homepage.webp"}));
  assert_eq!(card["homepageImageUrl"],"");assert_eq!(card["tileImageUrl"],card["imageUrl"]);
 }
 #[test] fn multigame_ids_are_not_rewritten() {
  let card=react_record(&json!({"card_id":20,"ct_id":10,"cdn_image_url":"https://cdn.pokoin.com/magic/10_card.jpg"}));
  assert_eq!(card["imageUrl"],"/card-images/magic/10_card.jpg");
 }
}

#[cfg(test)]
mod contract_tests {
 use super::*;
 fn numeric_normalize(v:&mut Value){
  match v {
   Value::Number(n)=>*v=json!(n.as_f64().unwrap()),
   Value::Array(a)=>for v in a{numeric_normalize(v)},
   Value::Object(o)=>for v in o.values_mut(){numeric_normalize(v)},
   _=>{}
  }
 }
 #[test]fn complete_card_contract_matches_reference_fixtures(){
  let cases:Vec<Value>=serde_json::from_str(include_str!("../fixtures/cards-contract.json")).unwrap();
  for (index,case) in cases.into_iter().enumerate(){
   let mut actual=react_record(&case["row"]);let mut expected=case["expected"].clone();
   numeric_normalize(&mut actual);numeric_normalize(&mut expected);
   assert_eq!(actual,expected,"card contract case {index}");
  }
 }
}
